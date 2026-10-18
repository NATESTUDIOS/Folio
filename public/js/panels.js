// public/js/panels.js
// ═══════════════════════════════════════════════════════════════════════
//  FOLIO — Panels (versions, preview, outline, 8 local panels)
// ═══════════════════════════════════════════════════════════════════════

import {
  $, el, icon,
  toast, openSheet, closeSheet, confirm,
  relativeTime, formatBytes, esc,
} from "./shared.js";

import { db } from "./db.js";
import { cm, workspace } from "./editor.js";


/* ── Edit ops ── */

export const editops = {
  async createVersion (pid, message) {
    const files = await db.listFiles(pid);
    if (files.length === 0) throw new Error("No files to commit");

    const fileSnapshot = {};
    let totalBytes = 0;
    for (const f of files) {
      fileSnapshot[f.path] = f.content;
      totalBytes += f.content.length;
    }

    const vid = `v_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    const version = {
      vid,
      pid,
      message: message || "Untitled version",
      files: fileSnapshot,
      size: totalBytes,
      createdAt: Date.now(),
    };

    await db.putVersion(version);
    return version;
  },

  async renderVersionList (container, pid) {
    if (!container) return;
    container.innerHTML = "";

    const versions = await db.listVersions(pid);
    if (versions.length === 0) {
      container.innerHTML = `
        <div class="empty-state">
          <div class="empty-state-icon">
            <svg width="24" height="24" fill="none" stroke="currentColor" stroke-width="1.8" viewBox="0 0 24 24">
              <circle cx="12" cy="12" r="10"/>
              <polyline points="12 6 12 12 16 14"/>
            </svg>
          </div>
          <div class="empty-state-title">No versions yet</div>
          <div class="empty-state-desc">Commit a version to snapshot the current state of your project.</div>
        </div>
      `;
      return;
    }

    for (const v of versions) {
      const item = el("div", {
        class: "version-item",
        role: "button",
        tabindex: "0",
        onclick: () => this.viewVersion(pid, v.vid),
        onkeydown: (e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            this.viewVersion(pid, v.vid);
          }
        },
      },
        el("div", { class: "version-message" }, v.message),
        el("div", { class: "version-meta" },
          el("span", { class: "version-stat" },
            icon("clock", 10),
            relativeTime(v.createdAt)
          ),
          el("span", { class: "version-stat" }, formatBytes(v.size)),
          el("span", { class: "version-stat" }, `${Object.keys(v.files).length} files`)
        )
      );
      container.appendChild(item);
    }
  },

  async viewVersion (pid, vid) {
    const version = await db.getVersion(vid);
    if (!version) {
      toast("Version not found", { type: "error" });
      return;
    }

    const files = Object.keys(version.files);
    const body = el("div", { class: "panel" },
      el("div", { class: "card card-compact" },
        el("div", { class: "font-semibold mb-2" }, version.message),
        el("div", { class: "text-xs text-muted" },
          `${relativeTime(version.createdAt)} · ${files.length} files · ${formatBytes(version.size)}`
        )
      ),
      el("div", { class: "panel-section" },
        el("div", { class: "panel-section-header" },
          el("span", { class: "panel-section-title" }, "Files")
        ),
        el("div", { class: "tree" },
          ...files.map(path => el("div", { class: "tree-node" },
            icon(this.iconForPath(path), 16),
            el("span", { class: "tree-node-name" }, path)
          ))
        )
      )
    );

    openSheet({
      title: "Version details",
      body,
      footer: el("div", { class: "flex gap-2", style: "width:100%" },
        el("button", {
          class: "btn btn-secondary",
          type: "button",
          style: "flex:1",
          onclick: () => closeSheet(),
        }, "Close"),
        el("button", {
          class: "btn btn-primary",
          type: "button",
          style: "flex:1",
          onclick: async () => {
            const ok = await confirm({
              title: "Restore this version?",
              message: "This will replace your current files with the ones from this version.",
              confirmLabel: "Restore",
            });
            if (!ok) return;
            await this.restoreVersion(pid, vid);
            closeSheet();
          },
        }, icon("refresh", 16), " Restore")
      ),
    });
  },

  async restoreVersion (pid, vid) {
    const version = await db.getVersion(vid);
    if (!version) return;

    const currentFiles = await db.listFiles(pid);
    for (const f of currentFiles) {
      await db.deleteFile(pid, f.path);
    }
    for (const [path, content] of Object.entries(version.files)) {
      await db.putFile(pid, path, content);
    }

    toast("Version restored", { type: "success" });

    if (workspace.currentProject?.pid === pid) {
      if (workspace.activeFile && version.files[workspace.activeFile] !== undefined) {
        await workspace.openFile(workspace.activeFile);
      } else if (Object.keys(version.files).length > 0) {
        await workspace.openFile(Object.keys(version.files)[0]);
      }
    }
  },

  async openPreview (container) {
    if (!workspace.currentProject) {
      toast("Open a project first", { type: "warning" });
      return;
    }

    const frame = container?.querySelector("#previewFrame") || $("previewFrame");
    if (!frame) return;

    const htmlFile = await this.findFile(workspace.currentProject.pid, "html");
    if (!htmlFile) {
      frame.srcdoc = `<html><body style="font-family:system-ui;background:#0a0c10;color:#e8ecf1;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;padding:20px;text-align:center;"><div><h2 style="margin:0 0 8px">No HTML file found</h2><p style="color:#a8b0bc;margin:0">Add an index.html to preview your project.</p></div></body></html>`;
      return;
    }

    const allFiles = await db.listFiles(workspace.currentProject.pid);
    const fileMap = {};
    for (const f of allFiles) fileMap[f.path] = f.content;

    let html = htmlFile.content;
    html = html.replace(/<link[^>]*href=["']([^"']+\.css)["'][^>]*>/gi, (match, href) => {
      const path = href.replace(/^\.\//, "");
      if (fileMap[path]) return `<style>\n${fileMap[path]}\n</style>`;
      return match;
    });
    html = html.replace(/<script[^>]*src=["']([^"']+\.js)["'][^>]*><\/script>/gi, (match, src) => {
      const path = src.replace(/^\.\//, "");
      if (fileMap[path]) return `<script>\n${fileMap[path]}\n</script>`;
      return match;
    });

    frame.srcdoc = html;
  },

  async findFile (pid, lang) {
    const files = await db.listFiles(pid);
    const extensions = lang === "html" ? ["html", "htm"] : [lang];
    return files.find(f => extensions.some(ext => f.path.endsWith("." + ext)));
  },

  async renderOutline (container) {
    if (!container) return;
    container.innerHTML = "";

    if (!cm.view) {
      container.innerHTML = `<div class="text-sm text-muted" style="padding:16px;text-align:center;">Open a file to see its outline.</div>`;
      return;
    }

    const content = cm.getContent();
    const path = workspace.activeFile || "";
    const lang = cm.detectLanguage(path);
    const items = this.extractOutline(content, lang);

    if (items.length === 0) {
      container.innerHTML = `<div class="text-sm text-muted" style="padding:16px;text-align:center;">No sections found in this file.</div>`;
      return;
    }

    for (const item of items) {
      const node = el("div", {
        class: `outline-item${item.level > 1 ? ` outline-item--level-${Math.min(item.level, 3)}` : ""}`,
        role: "button",
        tabindex: "0",
        onclick: () => this.jumpToLine(item.line),
        onkeydown: (e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            this.jumpToLine(item.line);
          }
        },
      },
        icon(item.icon || "hash", 14),
        el("span", { class: "outline-name" }, item.name),
        el("span", { class: "outline-line" }, String(item.line + 1))
      );
      container.appendChild(node);
    }
  },

  extractOutline (content, lang) {
    const items = [];
    const lines = content.split("\n");

    if (lang === "html") {
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const tagMatch = line.match(/<(\w+)[^>]*id=["']([^"']+)["']/);
        if (tagMatch) {
          const tag = tagMatch[1].toLowerCase();
          const level = tag.startsWith("h") && tag.length === 2 ? parseInt(tag[1]) : 3;
          items.push({ name: `#${tagMatch[2]}`, line: i, level, icon: "hash" });
        }
        const headingMatch = line.match(/<h([1-6])[^>]*>(.*?)<\/h\1>/);
        if (headingMatch && !tagMatch) {
          const level = parseInt(headingMatch[1]);
          const name = headingMatch[2].replace(/<[^>]+>/g, "").trim();
          if (name) items.push({ name, line: i, level, icon: "hash" });
        }
      }
    } else if (lang === "css") {
      for (let i = 0; i < lines.length; i++) {
        const match = lines[i].match(/^\s*([.#][\w-]+|\w+)\s*[{,]/);
        if (match) items.push({ name: match[1], line: i, level: 1, icon: "code" });
      }
    } else if (lang === "javascript") {
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const funcMatch = line.match(/(?:function\s+(\w+)|(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s*)?(?:\([^)]*\)|\w+)\s*=>)/);
        if (funcMatch) {
          const name = funcMatch[1] || funcMatch[2];
          if (name) items.push({ name, line: i, level: 1, icon: "code" });
        }
        const classMatch = line.match(/class\s+(\w+)/);
        if (classMatch) items.push({ name: classMatch[1], line: i, level: 1, icon: "hash" });
      }
    } else if (lang === "markdown") {
      for (let i = 0; i < lines.length; i++) {
        const match = lines[i].match(/^(#{1,6})\s+(.+)$/);
        if (match) items.push({ name: match[2], line: i, level: match[1].length, icon: "hash" });
      }
    }

    return items;
  },

  jumpToLine (line) {
    if (!cm.view) return;
    try {
      const lineStart = cm.view.state.doc.line(line + 1).from;
      cm.view.dispatch({
        selection: { anchor: lineStart },
        scrollIntoView: true,
      });
      cm.focus();
      closeSheet();
    } catch {}
  },

  iconForPath (path) {
    const ext = path.split(".").pop()?.toLowerCase();
    if (ext === "json") return "file-json";
    if (["js", "ts", "jsx", "tsx", "css", "html"].includes(ext)) return "file-code";
    return "file";
  },
};


/* ── Panel renderers ── */

async function renderFilesPanel () {
  const tpl = $("tpl-panel-files");
  if (!tpl) {
    toast("Files panel unavailable", { type: "error" });
    return;
  }

  openSheet({ title: "Project files", body: tpl.content.cloneNode(true) });

  const treeEl = $("fileTree");
  if (!treeEl) return;

  if (!workspace.currentProject) {
    treeEl.innerHTML = `
      <div class="empty-state">
        <div class="empty-state-icon">
          <svg width="24" height="24" fill="none" stroke="currentColor" stroke-width="1.8" viewBox="0 0 24 24">
            <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>
          </svg>
        </div>
        <div class="empty-state-title">No project open</div>
        <div class="empty-state-desc">Open a project first to see its files.</div>
      </div>
    `;
    return;
  }

  const render = async () => {
    const pid = workspace.currentProject?.pid;
    if (!pid) return;

    const files = await db.listFiles(pid);
    if (files.length === 0) {
      treeEl.innerHTML = `
        <div class="empty-state" style="padding:24px 16px">
          <div class="empty-state-icon">
            <svg width="24" height="24" fill="none" stroke="currentColor" stroke-width="1.8" viewBox="0 0 24 24">
              <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
              <polyline points="14 2 14 8 20 8"/>
            </svg>
          </div>
          <div class="empty-state-title">No files yet</div>
          <div class="empty-state-desc">Create your first file to start editing.</div>
          <button class="btn btn-primary btn-sm" id="filesPanelNewFile" style="margin-top:8px">New file</button>
        </div>
      `;
      $("filesPanelNewFile")?.addEventListener("click", () => {
        closeSheet();
        setTimeout(() => workspace.createFile(), 250);
      });
      return;
    }

    treeEl.innerHTML = "";
    for (const f of files) {
      const isActive = f.path === workspace.activeFile;
      const node = el("div", {
        class: `tree-node${isActive ? " active" : ""}`,
        role: "button",
        tabindex: "0",
        onclick: async () => {
          closeSheet();
          await workspace.openFile(f.path);
        },
        onkeydown: (e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            closeSheet();
            workspace.openFile(f.path);
          }
        },
      },
        el("span", { class: "tree-node-icon" }, icon(editops.iconForPath(f.path), 16)),
        el("span", { class: "tree-node-name" }, f.path),
        f.isPublic ? el("span", { class: "tree-node-public-dot", title: "Public" }) : null,
        el("button", {
          class: "tab-close",
          type: "button",
          "aria-label": `Delete ${f.path}`,
          onclick: (e) => {
            e.stopPropagation();
            workspace.deleteFile(f.path).then(() => render());
          },
        }, icon("trash", 10))
      );
      treeEl.appendChild(node);
    }
  };

  await render();

  const onCreated = () => render();
  const onDeleted = () => render();
  window.addEventListener("folio:file-created", onCreated);
  window.addEventListener("folio:file-deleted", onDeleted);

  window.__folioFilePanelClose = () => {
    window.removeEventListener("folio:file-created", onCreated);
    window.removeEventListener("folio:file-deleted", onDeleted);
    window.__folioFilePanelClose = null;
  };

  const sheetBody = $("sheetBody");
  sheetBody?.querySelector("[data-action='new-file']")?.addEventListener("click", () => {
    closeSheet();
    setTimeout(() => workspace.createFile(), 250);
  });

  sheetBody?.querySelector("[data-action='new-folder']")?.addEventListener("click", () => {
    closeSheet();
    setTimeout(() => workspace.createFolder(), 250);
  });

  sheetBody?.querySelector("[data-action='import-file']")?.addEventListener("click", async () => {
    if (!workspace.currentProject) return;
    const { transfer } = await import("./db.js");
    const result = await transfer.importFile(workspace.currentProject.pid);
    if (result) {
      toast(`Imported ${result.name}`, { type: "success" });
      render();
    }
  });
}

async function renderVersionsPanel () {
  const tpl = $("tpl-panel-versions");
  if (!tpl) return;
  openSheet({ title: "Version history", body: tpl.content.cloneNode(true) });

  if (!workspace.currentProject) {
    const list = $("versionList");
    if (list) list.innerHTML = `<div class="text-sm text-muted" style="padding:16px;text-align:center;">No project open</div>`;
    return;
  }

  await editops.renderVersionList($("versionList"), workspace.currentProject.pid);

  $("sheetBody")?.querySelector("[data-action='new-version']")?.addEventListener("click", () => {
    closeSheet();
    renderChangesPanel();
  });
}

async function renderChangesPanel () {
  const tpl = $("tpl-panel-changes");
  if (!tpl) return;
  openSheet({ title: "Commit changes", body: tpl.content.cloneNode(true) });

  if (!workspace.currentProject) return;

  const listEl = $("changesList");
  const suggestEl = $("commitSuggest");
  const summaryEl = $("commitSummary");
  if (!listEl || !suggestEl || !summaryEl) return;

  if (workspace.dirty && workspace.activeFile) {
    listEl.innerHTML = `
      <div class="list-row">
        <span class="list-row-name">${esc(workspace.activeFile)}</span>
        <span class="list-row-value" style="color:var(--accent)">Modified</span>
      </div>
    `;
  } else {
    listEl.innerHTML = `<div class="text-sm text-muted" style="padding:12px;text-align:center;">No unsaved changes</div>`;
  }

  suggestEl.innerHTML = "";
  const suggestions = [
    "Update " + (workspace.activeFile?.split("/").pop() || "files"),
    "Work in progress",
    "Fix small issue",
    "Save progress",
  ];
  for (const s of suggestions) {
    suggestEl.appendChild(el("button", {
      class: "commit-suggest-btn",
      type: "button",
      onclick: () => {
        const msg = $("commitMessage");
        if (msg) msg.value = s;
      },
    }, s));
  }

  const files = await db.listFiles(workspace.currentProject.pid);
  const versions = await db.listVersions(workspace.currentProject.pid);
  summaryEl.innerHTML = `
    <span><strong>${files.length}</strong> files</span>
    <span><strong>${versions.length}</strong> versions</span>
  `;

  const footer = $("sheetFooter");
  if (footer) {
    footer.innerHTML = "";
    footer.appendChild(el("button", {
      class: "btn btn-secondary",
      type: "button",
      onclick: () => closeSheet(),
    }, "Cancel"));
    footer.appendChild(el("button", {
      class: "btn btn-primary",
      type: "button",
      onclick: async (e) => {
        const btn = e.currentTarget;
        const msgInput = $("commitMessage");
        const message = (msgInput?.value || "").trim();

        if (!message) {
          toast("Add a message for this version", { type: "warning" });
          msgInput?.focus();
          return;
        }

        btn.disabled = true;
        btn.classList.add("loading");

        try {
          await editops.createVersion(workspace.currentProject.pid, message);
          workspace.dirty = false;
          workspace.updateDirtyDot();
          workspace.updateTabs();
          closeSheet();
          toast("Version committed", { type: "success" });
        } catch (err) {
          toast(err.message || "Couldn't commit version", { type: "error" });
          btn.disabled = false;
          btn.classList.remove("loading");
        }
      },
    }, icon("save", 16), " Commit version"));
    footer.classList.remove("hidden");
  }

  $("commitMessage")?.focus();
}

async function renderOutlinePanel () {
  const tpl = $("tpl-panel-outline");
  if (!tpl) return;
  openSheet({ title: "File outline", body: tpl.content.cloneNode(true) });
  await editops.renderOutline($("outlineList"));
}

async function renderNotepadPanel () {
  const tpl = $("tpl-panel-notepad");
  if (!tpl) return;
  openSheet({ title: "Notes", body: tpl.content.cloneNode(true) });

  if (!workspace.currentProject) return;
  const area = $("notepadArea");
  if (!area) return;
  const meta = await db.getProjectMeta(workspace.currentProject.pid);
  area.value = meta.notepad || "";

  area.addEventListener("blur", async () => {
    await db.setProjectMeta(workspace.currentProject.pid, { notepad: area.value });
    toast("Notes saved", { type: "success", duration: 1200 });
  });
}

async function renderSymbolsPanel () {
  const tpl = $("tpl-panel-symbols");
  if (!tpl) return;
  openSheet({ title: "Symbols", body: tpl.content.cloneNode(true) });

  const sheetBody = $("sheetBody");
  if (!sheetBody) return;

  sheetBody.querySelectorAll("[data-symbol]").forEach(btn => {
    btn.addEventListener("click", () => {
      cm.insertText(btn.dataset.symbol);
    });
  });
}

async function renderPreviewPanel () {
  const tpl = $("tpl-panel-preview");
  if (!tpl) return;
  openSheet({ title: "Live preview", body: tpl.content.cloneNode(true) });

  await editops.openPreview($("sheetBody"));

  const sheetBody = $("sheetBody");
  sheetBody?.querySelector("[data-action='preview-refresh']")?.addEventListener("click", async () => {
    await editops.openPreview($("sheetBody"));
  });
  sheetBody?.querySelector("[data-action='preview-close']")?.addEventListener("click", () => {
    closeSheet();
  });
}

async function renderJsonTreePanel () {
  const tpl = $("tpl-panel-jsontree");
  if (!tpl) return;
  openSheet({ title: "JSON tree", body: tpl.content.cloneNode(true) });

  const body = $("jsonTreeBody");
  if (!body) return;

  if (!cm.view) {
    body.innerHTML = `<div class="text-sm text-muted" style="padding:16px;text-align:center;">Open a JSON file first.</div>`;
    return;
  }

  const content = cm.getContent();
  try {
    const parsed = JSON.parse(content);
    body.innerHTML = "";
    renderJsonNode(body, parsed, "");
  } catch (err) {
    body.innerHTML = `<div class="text-sm" style="padding:16px;text-align:center;color:var(--danger);">Invalid JSON: ${esc(err.message.split(" ")[0])}</div>`;
  }

  $("sheetBody")?.querySelector("[data-action='copy-json']")?.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(content);
      toast("JSON copied", { type: "success" });
    } catch {
      toast("Couldn't copy", { type: "error" });
    }
  });
}

function renderJsonNode (parent, value, key) {
  if (value === null) {
    parent.appendChild(el("div", { class: "json-tree-node" },
      key ? el("span", { class: "json-tree-key" }, `"${key}": `) : null,
      el("span", { class: "json-tree-null" }, "null")
    ));
    return;
  }
  if (typeof value === "string") {
    parent.appendChild(el("div", { class: "json-tree-node" },
      key ? el("span", { class: "json-tree-key" }, `"${key}": `) : null,
      el("span", { class: "json-tree-string" }, `"${value}"`)
    ));
    return;
  }
  if (typeof value === "number") {
    parent.appendChild(el("div", { class: "json-tree-node" },
      key ? el("span", { class: "json-tree-key" }, `"${key}": `) : null,
      el("span", { class: "json-tree-number" }, String(value))
    ));
    return;
  }
  if (typeof value === "boolean") {
    parent.appendChild(el("div", { class: "json-tree-node" },
      key ? el("span", { class: "json-tree-key" }, `"${key}": `) : null,
      el("span", { class: "json-tree-boolean" }, String(value))
    ));
    return;
  }
  if (Array.isArray(value)) {
    parent.appendChild(el("div", { class: "json-tree-node" },
      el("span", { class: "json-tree-key" }, key ? `"${key}": ` : ""),
      `[ ${value.length} items ]`
    ));
    for (let i = 0; i < value.length; i++) {
      const child = el("div", { class: "json-tree-node", style: "padding-left:16px" });
      renderJsonNode(child, value[i], String(i));
      parent.appendChild(child);
    }
    return;
  }
  if (typeof value === "object") {
    const keys = Object.keys(value);
    parent.appendChild(el("div", { class: "json-tree-node" },
      el("span", { class: "json-tree-key" }, key ? `"${key}": ` : ""),
      `{ ${keys.length} keys }`
    ));
    for (const k of keys) {
      const child = el("div", { class: "json-tree-node", style: "padding-left:16px" });
      renderJsonNode(child, value[k], k);
      parent.appendChild(child);
    }
  }
}


export const localPanels = {
  files: renderFilesPanel,
  versions: renderVersionsPanel,
  changes: renderChangesPanel,
  outline: renderOutlinePanel,
  notepad: renderNotepadPanel,
  symbols: renderSymbolsPanel,
  preview: renderPreviewPanel,
  jsontree: renderJsonTreePanel,
};