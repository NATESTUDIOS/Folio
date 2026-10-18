// public/js/pages.js
// ═══════════════════════════════════════════════════════════════════════
//  FOLIO — Pages
//
//  Every non-editor page renderer. Called by boot.js based on URL.
//
//  All offline. All local. No API.
// ═══════════════════════════════════════════════════════════════════════

import {
  $, el, icon,
  toast, openSheet, closeSheet, confirm,
  relativeTime, formatBytes, esc,
  STORAGE_KEYS,
} from "./shared.js";

import {
  db, settings, estimateQuota, transfer,
  profile, analytics, notificationPrefs,
  cleanup,
} from "./db.js";

import { generators, TOOL_META } from "./generators.js";
import { renderProjectPicker, createProject } from "./project-picker.js";
import {
  listProjectsWithCounts, renameProject,
  deleteProjectWithConfirm, duplicateProject,
  exportProjectAsFile, renderProjectCard,
} from "./projects.js";


/* ═══════════════════════════════════════════════════════════════════════
   PAGE ROUTER
   ═══════════════════════════════════════════════════════════════════════ */

export async function renderPage (pageName, root) {
  if (!root) return;

  switch (pageName) {
    case "projects":      return renderProjectsPage(root);
    case "project":       return renderProjectPage(root);
    case "settings":      return renderSettingsPage(root);
    case "tools":         return renderToolsPage(root);
    case "profile":       return renderProfilePage(root);
    case "analytics":     return renderAnalyticsPage(root);
    case "notifications": return renderNotificationsPage(root);
    default:              return renderNotFoundPage(root);
  }
}


/* ═══════════════════════════════════════════════════════════════════════
   PROJECTS PAGE
   ═══════════════════════════════════════════════════════════════════════ */

async function renderProjectsPage (root) {
  root.innerHTML = `
    <div class="page-container">
      <div class="page-header">
        <div>
          <h1 class="page-title">Projects</h1>
          <p class="page-subtitle" id="projectsCount">Loading…</p>
        </div>
        <button class="btn btn-primary" id="newProjectBtn">
          <svg><use href="#icon-plus"/></svg>
          New project
        </button>
      </div>

      <div class="page-body">
        <div class="projects-grid" id="projectsGrid">
          <div class="skeleton" style="height:80px;border-radius:var(--radius-md)"></div>
          <div class="skeleton" style="height:80px;border-radius:var(--radius-md)"></div>
        </div>
      </div>
    </div>
  `;

  const load = async () => {
    const projects = await listProjectsWithCounts();
    const countEl = $("projectsCount");
    const gridEl = $("projectsGrid");

    if (countEl) {
      countEl.textContent = projects.length === 0
        ? "No projects yet"
        : `${projects.length} project${projects.length === 1 ? "" : "s"}`;
    }

    if (!gridEl) return;
    gridEl.innerHTML = "";

    if (projects.length === 0) {
      gridEl.innerHTML = `
        <div class="empty-state" style="grid-column:1/-1;">
          <div class="empty-state-icon">
            <svg width="24" height="24" fill="none" stroke="currentColor" stroke-width="1.8" viewBox="0 0 24 24">
              <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>
            </svg>
          </div>
          <div class="empty-state-title">No projects yet</div>
          <div class="empty-state-desc">Create your first project to start editing.</div>
          <button class="btn btn-primary" id="emptyNewProjectBtn" style="margin-top:8px">New project</button>
        </div>
      `;
      $("emptyNewProjectBtn")?.addEventListener("click", () => newProjectFlow());
      return;
    }

    let lastPid = null;
    try { lastPid = localStorage.getItem(STORAGE_KEYS.lastProject); } catch {}

    for (const p of projects) {
      const card = renderProjectCard(p, {
        isActive: p.pid === lastPid,
        onOpen: (project) => {
          try { localStorage.setItem(STORAGE_KEYS.lastProject, project.pid); } catch {}
          window.location.href = "/app";
        },
        onRename: async (project) => {
          const name = prompt("New name:", project.name);
          if (!name || name === project.name) return;
          try {
            await renameProject(project.pid, name);
            toast("Project renamed", { type: "success" });
            load();
          } catch (err) {
            toast(err.message, { type: "error" });
          }
        },
        onDuplicate: async (project) => {
          try {
            const dup = await duplicateProject(project.pid);
            toast(`Duplicated as ${dup.name}`, { type: "success" });
            load();
          } catch (err) {
            toast(err.message, { type: "error" });
          }
        },
        onExport: async (project) => {
          await exportProjectAsFile(project.pid);
        },
        onDelete: async (project) => {
          const deleted = await deleteProjectWithConfirm(project.pid);
          if (deleted) {
            toast("Project deleted", { type: "info" });
            load();
          }
        },
      });
      gridEl.appendChild(card);
    }
  };

  $("newProjectBtn")?.addEventListener("click", () => newProjectFlow());

  async function newProjectFlow () {
    const name = prompt("Project name:");
    if (!name) return;
    try {
      const project = await createProject(name);
      toast(`Created ${project.name}`, { type: "success" });
      load();
    } catch (err) {
      toast(err.message || "Couldn't create project", { type: "error" });
    }
  }

  await load();
}


/* ═══════════════════════════════════════════════════════════════════════
   PROJECT PAGE
   ═══════════════════════════════════════════════════════════════════════ */

async function renderProjectPage (root) {
  const params = new URLSearchParams(window.location.search);
  const pid = params.get("pid");

  if (!pid) {
    root.innerHTML = `
      <div class="page-container">
        <div class="empty-state" style="padding:64px 24px">
          <div class="empty-state-icon">
            <svg width="24" height="24" fill="none" stroke="currentColor" stroke-width="1.8" viewBox="0 0 24 24">
              <circle cx="12" cy="12" r="10"/>
              <line x1="12" y1="8" x2="12" y2="12"/>
              <line x1="12" y1="16" x2="12.01" y2="16"/>
            </svg>
          </div>
          <div class="empty-state-title">No project specified</div>
          <div class="empty-state-desc">Open a project from the Projects page.</div>
          <a href="/projects" class="btn btn-primary" style="margin-top:8px">View projects</a>
        </div>
      </div>
    `;
    return;
  }

  const project = await db.getProject(pid);
  if (!project) {
    root.innerHTML = `
      <div class="page-container">
        <div class="empty-state" style="padding:64px 24px">
          <div class="empty-state-title">Project not found</div>
          <div class="empty-state-desc">This project may have been deleted.</div>
          <a href="/projects" class="btn btn-primary" style="margin-top:8px">View projects</a>
        </div>
      </div>
    `;
    return;
  }

  const files = await db.listFiles(pid);
  const versions = await db.listVersions(pid);
  const meta = await db.getProjectMeta(pid);
  let totalBytes = 0;
  for (const f of files) totalBytes += f.content.length;

  root.innerHTML = `
    <div class="page-container">
      <div class="page-header">
        <div style="min-width:0">
          <div class="flex items-center gap-2 mb-2">
            <a href="/projects" class="btn btn-ghost btn-sm btn-icon" aria-label="Back to projects">
              <svg><use href="#icon-chevron-right" style="transform:rotate(180deg)"/></svg>
            </a>
            <h1 class="page-title" style="margin:0">${esc(project.name)}</h1>
          </div>
          <p class="page-subtitle">${esc(project.slug || "")} · Updated ${relativeTime(project.updatedAt)}</p>
        </div>
        <div class="flex gap-2">
          <button class="btn btn-secondary" id="openEditorBtn">
            <svg><use href="#icon-code"/></svg>
            Open in editor
          </button>
        </div>
      </div>

      <div class="page-body">
        <div class="stat-grid mb-3" style="margin-bottom:var(--space-5)">
          <div class="stat-tile">
            <div class="stat-value">${files.length}</div>
            <div class="stat-label">Files</div>
          </div>
          <div class="stat-tile">
            <div class="stat-value">${versions.length}</div>
            <div class="stat-label">Versions</div>
          </div>
          <div class="stat-tile">
            <div class="stat-value">${formatBytes(totalBytes)}</div>
            <div class="stat-label">Size</div>
          </div>
          <div class="stat-tile">
            <div class="stat-value">${files.filter(f => f.isPublic).length}</div>
            <div class="stat-label">Public files</div>
          </div>
        </div>

        <section class="page-section">
          <div class="page-section-header">
            <h2 class="page-section-title">Files</h2>
            <button class="btn btn-ghost btn-sm" id="openFilesBtn">Edit files</button>
          </div>
          <div class="flex flex-col gap-2" id="filesList"></div>
        </section>

        <section class="page-section">
          <div class="page-section-header">
            <h2 class="page-section-title">Versions</h2>
            <span class="text-xs text-muted">${versions.length} total</span>
          </div>
          <div class="flex flex-col gap-2" id="versionsList"></div>
        </section>

        <section class="page-section">
          <div class="page-section-header">
            <h2 class="page-section-title">Meta tags</h2>
          </div>
          <div class="flex flex-col gap-2">
            <div class="field">
              <label class="field-label">Title</label>
              <input type="text" class="input" id="metaTitle" value="${esc(meta.metaTitle || project.name)}" maxlength="70" placeholder="Page title (≤70 chars)">
            </div>
            <div class="field">
              <label class="field-label">Description</label>
              <textarea class="textarea" id="metaDesc" maxlength="200" placeholder="Page description (≤200 chars)" style="min-height:80px">${esc(meta.metaDescription || "")}</textarea>
            </div>
            <button class="btn btn-secondary" id="saveMetaBtn">Save meta tags (local)</button>
          </div>
        </section>

        <section class="page-section">
          <div class="page-section-header">
            <h2 class="page-section-title">Danger zone</h2>
          </div>
          <button class="btn btn-danger btn-block" id="deleteProjectBtn">
            <svg><use href="#icon-trash"/></svg>
            Delete project
          </button>
        </section>
      </div>
    </div>
  `;

  // Files list
  const filesList = $("filesList");
  if (filesList) {
    if (files.length === 0) {
      filesList.innerHTML = `<div class="text-sm text-muted" style="padding:12px;text-align:center;">No files</div>`;
    } else {
      for (const f of files) {
        filesList.appendChild(el("div", { class: "list-row" },
          el("div", { style: "flex:1;min-width:0;display:flex;align-items:center;gap:8px" },
            icon(f.path.endsWith(".json") ? "file-json" : "file-code", 14),
            el("span", { class: "list-row-name", style: "font-family:var(--font-mono)" }, f.path),
            f.isPublic ? el("span", { style: "color:var(--accent);font-size:10px;font-weight:600" }, "PUBLIC") : null
          ),
          el("span", { class: "text-xs text-muted" }, formatBytes(f.content.length))
        ));
      }
    }
  }

  // Versions list
  const versionsList = $("versionsList");
  if (versionsList) {
    if (versions.length === 0) {
      versionsList.innerHTML = `<div class="text-sm text-muted" style="padding:12px;text-align:center;">No versions committed yet</div>`;
    } else {
      for (const v of versions.slice(0, 10)) {
        versionsList.appendChild(el("div", { class: "list-row" },
          el("div", { style: "flex:1;min-width:0" },
            el("div", { class: "font-semibold", style: "font-size:13px" }, v.message),
            el("div", { class: "text-xs text-muted" },
              `${relativeTime(v.createdAt)} · ${formatBytes(v.size)} · ${Object.keys(v.files).length} files`
            )
          )
        ));
      }
    }
  }

  // Wire actions
  $("openEditorBtn")?.addEventListener("click", () => {
    try { localStorage.setItem(STORAGE_KEYS.lastProject, pid); } catch {}
    window.location.href = "/app";
  });

  $("openFilesBtn")?.addEventListener("click", () => {
    try { localStorage.setItem(STORAGE_KEYS.lastProject, pid); } catch {}
    window.location.href = "/app";
  });

  $("saveMetaBtn")?.addEventListener("click", async () => {
    const metaTitle = $("metaTitle").value.trim();
    const metaDescription = $("metaDesc").value.trim();
    await db.setProjectMeta(pid, { metaTitle, metaDescription });
    toast("Meta tags saved locally", { type: "success" });
  });

  $("deleteProjectBtn")?.addEventListener("click", async () => {
    const deleted = await deleteProjectWithConfirm(pid);
    if (deleted) {
      toast("Project deleted", { type: "info" });
      window.location.href = "/projects";
    }
  });
}


/* ═══════════════════════════════════════════════════════════════════════
   SETTINGS PAGE
   ═══════════════════════════════════════════════════════════════════════ */

async function renderSettingsPage (root) {
  root.innerHTML = `
    <div class="page-container">
      <div class="page-header">
        <div>
          <h1 class="page-title">Settings</h1>
          <p class="page-subtitle">Appearance, editor, storage, and app</p>
        </div>
      </div>

      <div class="page-body">
        <section class="page-section">
          <div class="page-section-header">
            <h2 class="page-section-title">Appearance</h2>
          </div>
          <div class="theme-picker" id="themePicker">
            <button class="theme-option" data-theme-value="dark">
              <div class="theme-swatch">
                <div class="theme-swatch-dark"></div>
                <div class="theme-swatch-dark"></div>
                <div class="theme-swatch-mid"></div>
              </div>
              <span class="theme-option-label">Dark</span>
            </button>
            <button class="theme-option" data-theme-value="light">
              <div class="theme-swatch">
                <div class="theme-swatch-light"></div>
                <div class="theme-swatch-light"></div>
                <div class="theme-swatch-mid"></div>
              </div>
              <span class="theme-option-label">Light</span>
            </button>
            <button class="theme-option" data-theme-value="auto">
              <div class="theme-swatch">
                <div class="theme-swatch-dark"></div>
                <div class="theme-swatch-light"></div>
                <div class="theme-swatch-mid"></div>
              </div>
              <span class="theme-option-label">Auto</span>
            </button>
          </div>
        </section>

        <section class="page-section">
          <div class="page-section-header">
            <h2 class="page-section-title">Editor</h2>
          </div>
          <div class="settings-group">
            <div class="settings-row">
              <span class="settings-row-label">Font size</span>
              <select class="select" id="prefFontSize" style="max-width:100px">
                <option value="12">12</option>
                <option value="13">13</option>
                <option value="14">14</option>
                <option value="15">15</option>
                <option value="16">16</option>
                <option value="18">18</option>
              </select>
            </div>
            <div class="settings-row">
              <span class="settings-row-label">Tab size</span>
              <select class="select" id="prefTabSize" style="max-width:100px">
                <option value="2">2</option>
                <option value="4">4</option>
              </select>
            </div>
            <div class="settings-row">
              <span class="settings-row-label">Line numbers</span>
              <label class="toggle">
                <input type="checkbox" id="prefLineNumbers">
                <span class="toggle-track"><span class="toggle-thumb"></span></span>
              </label>
            </div>
            <div class="settings-row">
              <span class="settings-row-label">Word wrap</span>
              <label class="toggle">
                <input type="checkbox" id="prefWordWrap">
                <span class="toggle-track"><span class="toggle-thumb"></span></span>
              </label>
            </div>
          </div>
        </section>

        <section class="page-section">
          <div class="page-section-header">
            <h2 class="page-section-title">Storage</h2>
          </div>
          <div class="settings-group">
            <div class="settings-row">
              <span class="settings-row-label">Usage</span>
              <span class="settings-row-value" id="storageUsage">—</span>
            </div>
            <button class="btn btn-secondary btn-block" id="exportBackupBtn">
              <svg><use href="#icon-download"/></svg>
              Export full backup
            </button>
            <button class="btn btn-secondary btn-block" id="importBackupBtn">
              <svg><use href="#icon-upload"/></svg>
              Import backup
            </button>
            <button class="btn btn-secondary btn-block" id="cleanupBtn">
              <svg><use href="#icon-trash"/></svg>
              Clean up old versions
            </button>
          </div>
        </section>

        <section class="page-section">
          <div class="page-section-header">
            <h2 class="page-section-title">App</h2>
          </div>
          <div class="settings-group">
            <button class="btn btn-secondary btn-block" id="installBtn">
              <svg><use href="#icon-download"/></svg>
              Install Folio
            </button>
            <button class="btn btn-secondary btn-block" id="checkUpdateBtn">
              <svg><use href="#icon-refresh"/></svg>
              Check for updates
            </button>
          </div>
        </section>
      </div>
    </div>
  `;

  // Theme picker
  const theme = window.__folioTheme || { current: "dark", set: () => {} };
  document.querySelectorAll(".theme-option").forEach(opt => {
    opt.classList.toggle("active", opt.dataset.themeValue === theme.current);
    opt.addEventListener("click", () => theme.set(opt.dataset.themeValue));
  });

  // Prefs
  const fontSizeEl = $("prefFontSize");
  const tabSizeEl = $("prefTabSize");
  const lineNumbersEl = $("prefLineNumbers");
  const wordWrapEl = $("prefWordWrap");

  if (fontSizeEl) fontSizeEl.value = String(settings.fontSize);
  if (tabSizeEl) tabSizeEl.value = String(settings.tabSize);
  if (lineNumbersEl) lineNumbersEl.checked = settings.lineNumbers;
  if (wordWrapEl) wordWrapEl.checked = settings.wordWrap;

  fontSizeEl?.addEventListener("change", (e) => {
    settings.fontSize = parseInt(e.target.value, 10);
    settings.save();
    toast("Font size saved", { type: "success", duration: 1500 });
  });

  tabSizeEl?.addEventListener("change", (e) => {
    settings.tabSize = parseInt(e.target.value, 10);
    settings.save();
    toast("Tab size saved", { type: "success", duration: 1500 });
  });

  lineNumbersEl?.addEventListener("change", (e) => {
    settings.lineNumbers = e.target.checked;
    settings.save();
  });

  wordWrapEl?.addEventListener("change", (e) => {
    settings.wordWrap = e.target.checked;
    settings.save();
  });

  // Storage usage
  const quota = await estimateQuota();
  const usageEl = $("storageUsage");
  if (usageEl) {
    usageEl.textContent = quota.quota > 0
      ? `${formatBytes(quota.usage)} of ${formatBytes(quota.quota)}`
      : formatBytes(quota.usage);
  }

  $("exportBackupBtn")?.addEventListener("click", async () => {
    const ok = await transfer.exportFullBackup();
    if (ok) toast("Backup exported", { type: "success" });
  });

  $("importBackupBtn")?.addEventListener("click", async () => {
    const result = await transfer.importBackup(async (count) => {
      return await confirm({
        title: "Restore backup?",
        message: `This will add ${count} project${count === 1 ? "" : "s"} to your workspace. Existing projects with the same ID will be overwritten.`,
        confirmLabel: "Restore",
      });
    });
    if (result && result.count) {
      toast(`Restored ${result.count} project${result.count === 1 ? "" : "s"}`, { type: "success" });
    } else if (result && result.error) {
      toast(result.error, { type: "error" });
    }
  });

  $("cleanupBtn")?.addEventListener("click", async () => {
    const ok = await confirm({
      title: "Clean up old versions?",
      message: "This will delete versions older than 30 days or beyond 50 per project, keeping the most recent.",
      confirmLabel: "Clean up",
    });
    if (!ok) return;

    const projects = await db.listProjects();
    for (const p of projects) {
      await cleanup.forceCleanup(p.pid);
    }
    toast("Cleanup complete", { type: "success" });
  });

  $("installBtn")?.addEventListener("click", () => {
    window.__folioInstall?.promptInstall?.();
  });

  $("checkUpdateBtn")?.addEventListener("click", () => {
    window.__folioInstall?.checkForUpdate?.();
  });
}


/* ═══════════════════════════════════════════════════════════════════════
   TOOLS PAGE
   ═══════════════════════════════════════════════════════════════════════ */

async function renderToolsPage (root) {
  root.innerHTML = `
    <div class="page-container">
      <div class="page-header">
        <div>
          <h1 class="page-title">Tools</h1>
          <p class="page-subtitle">Dev utilities that work offline</p>
        </div>
      </div>

      <div class="page-body">
        <div class="tool-grid" id="toolsGrid"></div>
      </div>
    </div>
  `;

  const grid = $("toolsGrid");
  if (!grid) return;

  const onInsert = (text) => {
    navigator.clipboard.writeText(text).then(() => {
      toast("Copied to clipboard (open /app to insert)", { type: "success", duration: 3000 });
    }).catch(() => {
      toast("Couldn't copy", { type: "error" });
    });
  };

  for (const tool of TOOL_META) {
    const tile = el("button", {
      class: "tool-tile",
      type: "button",
      onclick: () => {
        const container = el("div");
        openSheet({ title: tool.name, body: container });
        generators[tool.id]?.render(container, { onInsert });
      },
    },
      el("div", { class: "tool-tile-icon" }, icon(tool.icon, 16)),
      el("div", { class: "tool-tile-name" }, tool.name),
      el("div", { class: "tool-tile-desc" }, tool.desc)
    );
    grid.appendChild(tile);
  }
}


/* ═══════════════════════════════════════════════════════════════════════
   PROFILE PAGE
   ═══════════════════════════════════════════════════════════════════════ */

async function renderProfilePage (root) {
  const prof = await profile.get();
  const projects = await listProjectsWithCounts();

  root.innerHTML = `
    <div class="page-container">
      <div class="page-header">
        <div>
          <h1 class="page-title">Profile</h1>
          <p class="page-subtitle">Your local identity</p>
        </div>
      </div>

      <div class="page-body">
        <section class="page-section">
          <div class="profile-hero">
            <div class="profile-avatar" id="profileAvatar"></div>
            <div class="profile-info">
              <div class="profile-name" id="profileName">${esc(prof.displayName || "Unnamed")}</div>
              <div class="profile-bio" id="profileBio">${esc(prof.bio || "No bio yet")}</div>
            </div>
            <button class="btn btn-secondary" id="editProfileBtn">
              <svg><use href="#icon-edit"/></svg>
              Edit
            </button>
          </div>
        </section>

        <section class="page-section">
          <div class="page-section-header">
            <h2 class="page-section-title">Projects (${projects.length})</h2>
          </div>
          <div class="projects-grid" id="profileProjectsGrid"></div>
        </section>
      </div>
    </div>
  `;

  // Avatar
  const avatarEl = $("profileAvatar");
  if (avatarEl) {
    const name = prof.displayName || "?";
    if (prof.avatarUrl) {
      avatarEl.innerHTML = `<img src="${esc(prof.avatarUrl)}" alt="" onerror="this.style.display='none';this.parentElement.textContent='${esc(name.charAt(0).toUpperCase())}'">`;
    } else {
      avatarEl.textContent = name.charAt(0).toUpperCase();
    }
  }

  // Project grid
  const grid = $("profileProjectsGrid");
  if (grid) {
    if (projects.length === 0) {
      grid.innerHTML = `<div class="text-sm text-muted" style="grid-column:1/-1;padding:12px;text-align:center;">No projects yet</div>`;
    } else {
      for (const p of projects) {
        grid.appendChild(el("a", {
          class: "project-card",
          href: `/project?pid=${encodeURIComponent(p.pid)}`,
          style: "text-decoration:none;color:inherit;cursor:pointer",
        },
          el("div", { class: "project-card-icon" }, icon("folder", 20)),
          el("div", { style: "flex:1;min-width:0" },
            el("div", { class: "project-card-name" }, p.name),
            el("div", { class: "project-card-meta" },
              `${p.fileCount} files · ${p.versionCount} versions`
            )
          )
        ));
      }
    }
  }

  // Edit profile
  $("editProfileBtn")?.addEventListener("click", () => openEditProfileSheet(prof));
}

function openEditProfileSheet (prof) {
  const body = el("div", { class: "panel" },
    el("div", { class: "panel-section" },
      el("div", { class: "field" },
        el("label", { class: "field-label" }, "Display name"),
        el("input", { type: "text", class: "input", id: "editDisplayName", value: prof.displayName || "", maxlength: "60" })
      ),
      el("div", { class: "field" },
        el("label", { class: "field-label" }, "Bio"),
        el("textarea", { class: "textarea", id: "editBio", maxlength: "500", style: "min-height:80px" }, prof.bio || "")
      ),
      el("div", { class: "field" },
        el("label", { class: "field-label" }, "Avatar URL"),
        el("input", { type: "url", class: "input", id: "editAvatarUrl", value: prof.avatarUrl || "", placeholder: "https://…" })
      )
    ),
    el("button", {
      class: "btn btn-primary btn-block",
      type: "button",
      id: "editProfileSave",
    }, icon("save", 16), " Save profile")
  );

  openSheet({ title: "Edit profile", body });

  $("editProfileSave")?.addEventListener("click", async () => {
    const displayName = $("editDisplayName").value.trim();
    const bio = $("editBio").value.trim();
    const avatarUrl = $("editAvatarUrl").value.trim();

    await profile.update({ displayName, bio, avatarUrl: avatarUrl || null });
    toast("Profile saved", { type: "success" });
    closeSheet();
    setTimeout(() => renderProfilePage(document.getElementById("page-root")), 250);
  });
}


/* ═══════════════════════════════════════════════════════════════════════
   ANALYTICS PAGE
   ═══════════════════════════════════════════════════════════════════════ */

async function renderAnalyticsPage (root) {
  const stats = await analytics.getGlobalStats();

  root.innerHTML = `
    <div class="page-container">
      <div class="page-header">
        <div>
          <h1 class="page-title">Storage Analytics</h1>
          <p class="page-subtitle">Local storage breakdown — no network data</p>
        </div>
      </div>

      <div class="page-body">
        <div class="stat-grid" style="margin-bottom:var(--space-5)">
          <div class="stat-tile">
            <div class="stat-value">${stats.projectCount}</div>
            <div class="stat-label">Projects</div>
          </div>
          <div class="stat-tile">
            <div class="stat-value">${stats.fileCount}</div>
            <div class="stat-label">Files</div>
          </div>
          <div class="stat-tile">
            <div class="stat-value">${stats.versionCount}</div>
            <div class="stat-label">Versions</div>
          </div>
          <div class="stat-tile">
            <div class="stat-value">${formatBytes(stats.totalBytes)}</div>
            <div class="stat-label">Total size</div>
          </div>
        </div>

        <section class="page-section">
          <div class="page-section-header">
            <h2 class="page-section-title">Projects by size</h2>
          </div>
          <div class="flex flex-col gap-2" id="projectSizeList"></div>
        </section>
      </div>
    </div>
  `;

  const list = $("projectSizeList");
  if (!list) return;

  if (stats.perProject.length === 0) {
    list.innerHTML = `<div class="text-sm text-muted" style="padding:12px;text-align:center;">No projects yet</div>`;
    return;
  }

  const maxBytes = stats.perProject[0]?.bytes || 1;
  for (const p of stats.perProject) {
    const pct = Math.max(2, (p.bytes / maxBytes) * 100);
    list.appendChild(el("div", { class: "card card-compact" },
      el("div", { class: "flex items-center justify-between mb-2" },
        el("div", { class: "font-semibold" }, p.name),
        el("div", { class: "text-xs text-muted" }, formatBytes(p.bytes))
      ),
      el("div", { style: "height:6px;background:var(--border-faint);border-radius:3px;overflow:hidden" },
        el("div", { style: `height:100%;width:${pct}%;background:var(--accent);border-radius:3px` })
      ),
      el("div", { class: "text-xs text-muted mt-2" },
        `${p.fileCount} files · ${p.versionCount} versions · updated ${relativeTime(p.updatedAt)}`
      )
    ));
  }
}


/* ═══════════════════════════════════════════════════════════════════════
   NOTIFICATIONS PAGE
   ═══════════════════════════════════════════════════════════════════════ */

async function renderNotificationsPage (root) {
  const prefs = await notificationPrefs.get();

  root.innerHTML = `
    <div class="page-container">
      <div class="page-header">
        <div>
          <h1 class="page-title">Notifications</h1>
          <p class="page-subtitle">Preferences are stored locally</p>
        </div>
      </div>

      <div class="page-body">
        <section class="page-section">
          <div class="page-section-header">
            <h2 class="page-section-title">Push notifications</h2>
          </div>
          <div class="alert alert-info">
            <svg><use href="#icon-info"/></svg>
            <div>Push notifications are not yet wired up. When cloud sync is enabled, your preferences here will apply.</div>
          </div>
          <div class="settings-group">
            <div class="settings-row">
              <span class="settings-row-label">Enable push</span>
              <label class="toggle">
                <input type="checkbox" id="prefPushEnabled" ${prefs.pushEnabled ? "checked" : ""}>
                <span class="toggle-track"><span class="toggle-thumb"></span></span>
              </label>
            </div>
          </div>
        </section>

        <section class="page-section">
          <div class="page-section-header">
            <h2 class="page-section-title">Alert types</h2>
          </div>
          <div class="settings-group">
            <div class="settings-row">
              <span class="settings-row-label">System</span>
              <label class="toggle">
                <input type="checkbox" id="prefSystem" ${prefs.systemAlerts ? "checked" : ""}>
                <span class="toggle-track"><span class="toggle-thumb"></span></span>
              </label>
            </div>
            <div class="settings-row">
              <span class="settings-row-label">Analytics</span>
              <label class="toggle">
                <input type="checkbox" id="prefAnalytics" ${prefs.analyticsAlerts ? "checked" : ""}>
                <span class="toggle-track"><span class="toggle-thumb"></span></span>
              </label>
            </div>
            <div class="settings-row">
              <span class="settings-row-label">Database</span>
              <label class="toggle">
                <input type="checkbox" id="prefDb" ${prefs.dbAlerts ? "checked" : ""}>
                <span class="toggle-track"><span class="toggle-thumb"></span></span>
              </label>
            </div>
            <div class="settings-row">
              <span class="settings-row-label">Storage</span>
              <label class="toggle">
                <input type="checkbox" id="prefStorage" ${prefs.storageAlerts ? "checked" : ""}>
                <span class="toggle-track"><span class="toggle-thumb"></span></span>
              </label>
            </div>
            <div class="settings-row">
              <span class="settings-row-label">Projects</span>
              <label class="toggle">
                <input type="checkbox" id="prefProjects" ${prefs.projectAlerts ? "checked" : ""}>
                <span class="toggle-track"><span class="toggle-thumb"></span></span>
              </label>
            </div>
          </div>
        </section>

        <section class="page-section">
          <div class="page-section-header">
            <h2 class="page-section-title">Quiet hours</h2>
          </div>
          <div class="settings-group">
            <div class="settings-row">
              <span class="settings-row-label">Enable quiet hours</span>
              <label class="toggle">
                <input type="checkbox" id="prefQuietEnabled" ${prefs.quietHours?.enabled ? "checked" : ""}>
                <span class="toggle-track"><span class="toggle-thumb"></span></span>
              </label>
            </div>
            <div class="flex gap-2">
              <div class="field" style="flex:1">
                <label class="field-label">Start</label>
                <input type="time" class="input" id="prefQuietStart" value="${prefs.quietHours?.start || "22:00"}">
              </div>
              <div class="field" style="flex:1">
                <label class="field-label">End</label>
                <input type="time" class="input" id="prefQuietEnd" value="${prefs.quietHours?.end || "07:00"}">
              </div>
            </div>
          </div>
        </section>
      </div>
    </div>
  `;

  const save = async () => {
    await notificationPrefs.update({
      pushEnabled: $("prefPushEnabled")?.checked ?? false,
      systemAlerts: $("prefSystem")?.checked ?? true,
      analyticsAlerts: $("prefAnalytics")?.checked ?? true,
      dbAlerts: $("prefDb")?.checked ?? true,
      storageAlerts: $("prefStorage")?.checked ?? true,
      projectAlerts: $("prefProjects")?.checked ?? true,
      quietHours: {
        enabled: $("prefQuietEnabled")?.checked ?? false,
        start: $("prefQuietStart")?.value || "22:00",
        end: $("prefQuietEnd")?.value || "07:00",
      },
    });
    toast("Preferences saved", { type: "success", duration: 1500 });
  };

  ["prefPushEnabled", "prefSystem", "prefAnalytics", "prefDb", "prefStorage",
   "prefProjects", "prefQuietEnabled", "prefQuietStart", "prefQuietEnd"].forEach(id => {
    $(id)?.addEventListener("change", save);
  });
}


/* ═══════════════════════════════════════════════════════════════════════
   404
   ═══════════════════════════════════════════════════════════════════════ */

function renderNotFoundPage (root) {
  root.innerHTML = `
    <div class="page-container">
      <div class="empty-state" style="padding:64px 24px">
        <div class="empty-state-icon">
          <svg width="24" height="24" fill="none" stroke="currentColor" stroke-width="1.8" viewBox="0 0 24 24">
            <circle cx="12" cy="12" r="10"/>
            <line x1="12" y1="8" x2="12" y2="12"/>
            <line x1="12" y1="16" x2="12.01" y2="16"/>
          </svg>
        </div>
        <div class="empty-state-title">Page not found</div>
        <div class="empty-state-desc">This page doesn't exist.</div>
        <a href="/projects" class="btn btn-primary" style="margin-top:8px">Go to projects</a>
      </div>
    </div>
  `;
}