// public/js/editor.js
// ═══════════════════════════════════════════════════════════════════════
//  FOLIO — Editor (CodeMirror + workspace)
// ═══════════════════════════════════════════════════════════════════════

import {
  $, el, icon,
  toast, confirm,
  STORAGE_KEYS,
} from "./shared.js";

import {
  db, guardedWrite, QuotaError, settings,
} from "./db.js";


/* ── CodeMirror ── */

export const cm = {
  view: null,
  modules: null,
  currentLang: "html",
  _loading: null,
  _dirtyCallback: null,

  async loadModules () {
    if (this.modules) return this.modules;
    if (this._loading) return this._loading;

    this._loading = (async () => {
      console.log("[CM] Loading modules from esm.sh…");
      const [
        basicSetup,
        htmlLang,
        cssLang,
        jsLang,
        jsonLang,
        mdLang,
        oneDark,
        searchMod,
        commandsMod,
      ] = await Promise.all([
        import("https://esm.sh/@codemirror/basic-setup@0.20.0"),
        import("https://esm.sh/@codemirror/lang-html@6.4.6"),
        import("https://esm.sh/@codemirror/lang-css@6.2.1"),
        import("https://esm.sh/@codemirror/lang-javascript@6.2.1"),
        import("https://esm.sh/@codemirror/lang-json@6.0.1"),
        import("https://esm.sh/@codemirror/lang-markdown@6.2.3"),
        import("https://esm.sh/@codemirror/theme-one-dark@6.1.2"),
        import("https://esm.sh/@codemirror/search@6.5.0"),
        import("https://esm.sh/@codemirror/commands@6.3.0"),
      ]);

      const m = {
        basicSetup: basicSetup.basicSetup,
        EditorView: basicSetup.EditorView ||
          (await import("https://esm.sh/@codemirror/view@6.22.0")).EditorView,
        EditorState: basicSetup.EditorState ||
          (await import("https://esm.sh/@codemirror/state@6.3.1")).EditorState,
        html: htmlLang.html,
        css: cssLang.css,
        javascript: jsLang.javascript,
        json: jsonLang.json,
        markdown: mdLang.markdown,
        oneDark: oneDark.oneDark,
        search: searchMod,
        commands: commandsMod,
      };

      this.modules = m;
      console.log("[CM] Modules loaded");
      return m;
    })();

    try {
      return await this._loading;
    } catch (err) {
      this._loading = null;
      console.error("[CM] Module load failed:", err);
      throw err;
    }
  },

  getLanguageExtension (lang) {
    if (!this.modules) return [];
    const m = this.modules;
    switch (lang) {
      case "html": return m.html();
      case "css": return m.css();
      case "javascript": return m.javascript();
      case "json": return m.json();
      case "markdown": return m.markdown();
      default: return [];
    }
  },

  detectLanguage (path) {
    if (!path) return "html";
    const ext = path.split(".").pop()?.toLowerCase();
    switch (ext) {
      case "html":
      case "htm": return "html";
      case "css": return "css";
      case "js":
      case "mjs":
      case "cjs": return "javascript";
      case "json": return "json";
      case "md":
      case "markdown": return "markdown";
      default: return "html";
    }
  },

  async init (container, content, path) {
    const m = await this.loadModules();
    const lang = this.detectLanguage(path);
    this.currentLang = lang;

    if (this.view) {
      this.view.destroy();
      this.view = null;
    }

    const extensions = [
      m.basicSetup,
      this.getLanguageExtension(lang),
      m.oneDark,
      m.EditorView.lineWrapping,
      m.EditorView.updateListener.of((update) => {
        if (update.docChanged && typeof this._dirtyCallback === "function") {
          this._dirtyCallback();
        }
      }),
    ];

    if (m.search?.searchKeymap) {
      const viewMod = await import("https://esm.sh/@codemirror/view@6.22.0");
      extensions.push(viewMod.keymap.of([
        ...m.search.searchKeymap,
        ...m.commands.defaultKeymap,
      ]));
    }

    const state = m.EditorState.create({
      doc: content || "",
      extensions,
    });

    this.view = new m.EditorView({
      state,
      parent: container,
    });

    const scroller = container.querySelector(".cm-scroller");
    const contentEl = container.querySelector(".cm-content");
    if (scroller) scroller.style.fontSize = `${settings.fontSize}px`;
    if (contentEl) {
      contentEl.style.fontSize = `${settings.fontSize}px`;
      contentEl.style.tabSize = String(settings.tabSize);
    }

    return this.view;
  },

  onDirty (cb) { this._dirtyCallback = cb; },

  setContent (content) {
    if (!this.view || !this.modules) return;
    const transaction = this.view.state.update({
      changes: { from: 0, to: this.view.state.doc.length, insert: content || "" },
    });
    this.view.dispatch(transaction);
  },

  getContent () {
    return this.view?.state.doc.toString() || "";
  },

  selectAll () {
    if (!this.view) return;
    this.view.dispatch({
      selection: { anchor: 0, head: this.view.state.doc.length },
    });
    this.view.focus();
  },

  insertText (text) {
    if (!this.view) return;
    const sel = this.view.state.selection.main;
    this.view.dispatch({
      changes: { from: sel.from, to: sel.to, insert: text },
      selection: { anchor: sel.from + text.length },
    });
    this.view.focus();
  },

  undo () {
    if (!this.view || !this.modules) return;
    this.modules.commands.undo(this.view);
  },

  redo () {
    if (!this.view || !this.modules) return;
    this.modules.commands.redo(this.view);
  },

  openSearch () {
    if (!this.view || !this.modules?.search) {
      toast("Search unavailable", { type: "warning" });
      return;
    }
    this.modules.search.openSearchPanel(this.view);
  },

  formatJSON () {
    if (!this.view) return;
    try {
      const content = this.getContent();
      const parsed = JSON.parse(content);
      this.setContent(JSON.stringify(parsed, null, settings.tabSize));
      toast("Formatted", { type: "success", duration: 1500 });
    } catch {
      toast("Invalid JSON — can't format", { type: "error" });
    }
  },

  focus () { this.view?.focus(); },

  destroy () {
    if (this.view) {
      this.view.destroy();
      this.view = null;
    }
  },
};


/* ── Workspace ── */

export const workspace = {
  currentProject: null,
  openFiles: [],
  activeFile: null,
  dirty: false,

  async loadLastProject () {
    let pid = null;
    try { pid = localStorage.getItem(STORAGE_KEYS.lastProject); } catch {}
    if (!pid) return null;

    const project = await db.getProject(pid);
    if (!project) return null;

    await this.openProject(project);
    return project;
  },

  async openProject (project) {
    this.currentProject = project;
    try { localStorage.setItem(STORAGE_KEYS.lastProject, project.pid); } catch {}

    let lastPath = null;
    try { lastPath = localStorage.getItem(STORAGE_KEYS.lastFile); } catch {}

    this.openFiles = [];
    this.activeFile = null;
    this.dirty = false;

    this.updateBreadcrumb();
    this.updateTabs();
    this.updateDirtyDot();

    cm.onDirty(() => this.markDirty());

    const files = await db.listFiles(project.pid);
    if (files.length > 0) {
      const target = (lastPath && files.find(f => f.path === lastPath)) || files[0];
      await this.openFile(target.path);
    } else {
      this.showEmptyEditor("No files in this project");
    }

    import("./db.js").then(({ cleanup }) => {
      cleanup.maybeRun(project.pid).catch(() => {});
    });
  },

  async openFile (path) {
    if (!this.currentProject) return;
    const pid = this.currentProject.pid;

    const file = await db.getFile(pid, path);
    if (!file) {
      toast("File not found", { type: "error" });
      return;
    }

    if (!this.openFiles.includes(path)) {
      this.openFiles.push(path);
    }
    this.activeFile = path;
    try { localStorage.setItem(STORAGE_KEYS.lastFile, path); } catch {}

    this.dirty = false;
    this.updateTabs();
    this.updateBreadcrumb();
    this.updateDirtyDot();

    const container = $("editorContainer");
    if (!container) return;

    const loading = $("editorLoading");
    if (!cm.modules && loading) {
      loading.classList.remove("hide");
      container.innerHTML = "";
      $("editorEmpty")?.classList.remove("visible");
    }

    try {
      await cm.init(container, file.content, path);
      loading?.classList.add("hide");
      $("editorEmpty")?.classList.remove("visible");
    } catch (err) {
      console.error("[Workspace] Editor failed:", err);
      loading?.classList.add("hide");
      this.showEditorError();
    }
  },

  showEditorError () {
    const container = $("editorContainer");
    const empty = $("editorEmpty");
    if (!container) return;

    container.innerHTML = "";
    $("tabs")?.classList.add("hidden");

    container.innerHTML = `
      <div class="editor-empty visible" style="display:flex">
        <div class="editor-empty-icon">
          <svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
        </div>
        <h2 class="editor-empty-title">Couldn't load editor</h2>
        <p class="editor-empty-desc">CodeMirror needs an internet connection the first time it loads. Check your connection and try again.</p>
        <div class="editor-empty-actions">
          <button class="btn btn-primary" id="editorRetryBtn">
            <svg viewBox="0 0 24 24"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>
            Try again
          </button>
        </div>
      </div>
    `;
    empty?.classList.remove("visible");

    $("editorRetryBtn")?.addEventListener("click", () => {
      const path = this.activeFile;
      if (!path) return;
      container.innerHTML = "";
      $("editorLoading")?.classList.remove("hide");
      this.openFile(path);
    });
  },

  async closeFile (path) {
    if (path === this.activeFile && this.dirty) {
      const ok = await confirm({
        title: "Unsaved changes",
        message: `Discard unsaved changes to ${path.split("/").pop()}?`,
        confirmLabel: "Discard",
        danger: true,
      });
      if (!ok) return;
    }

    const idx = this.openFiles.indexOf(path);
    if (idx >= 0) this.openFiles.splice(idx, 1);

    if (this.activeFile === path) {
      if (this.openFiles.length > 0) {
        await this.openFile(this.openFiles[this.openFiles.length - 1]);
      } else {
        this.activeFile = null;
        this.showEmptyEditor();
        this.updateTabs();
        this.updateBreadcrumb();
      }
    } else {
      this.updateTabs();
    }
  },

  async saveActiveFile () {
    if (!this.currentProject || !this.activeFile) {
      toast("No file open to save", { type: "info", duration: 2000 });
      return;
    }
    if (!cm.view) {
      toast("Editor not ready", { type: "info", duration: 2000 });
      return;
    }

    const content = cm.getContent();
    const pid = this.currentProject.pid;

    try {
      await guardedWrite(() => db.putFile(pid, this.activeFile, content), {
        estimatedBytes: content.length,
      });

      const project = await db.getProject(pid);
      if (project) {
        project.updatedAt = Date.now();
        await db.putProject(project);
      }

      this.dirty = false;
      this.updateDirtyDot();
      this.updateTabs();
      toast(`Saved ${this.activeFile.split("/").pop()}`, { type: "success", duration: 1500 });
    } catch (err) {
      if (err instanceof QuotaError) {
        toast(err.message, { type: "error", duration: 5000 });
      } else {
        toast("Couldn't save your changes. Try again.", { type: "error" });
      }
    }
  },

  markDirty () {
    if (!this.dirty) {
      this.dirty = true;
      this.updateDirtyDot();
      this.updateTabs();
    }
  },

  updateDirtyDot () {
    const dot = $("dirtyDot");
    if (dot) dot.classList.toggle("visible", this.dirty);
  },

  updateBreadcrumb () {
    const projectEl = $("breadcrumbProject");
    if (!projectEl) return;
    if (this.currentProject) {
      projectEl.textContent = this.currentProject.name;
      projectEl.classList.toggle("current", !this.activeFile);
    } else {
      projectEl.textContent = "No project";
    }
  },

  updateTabs () {
    const tabsEl = $("tabs");
    if (!tabsEl) return;

    if (this.openFiles.length === 0) {
      tabsEl.classList.add("hidden");
      tabsEl.innerHTML = "";
      return;
    }

    tabsEl.classList.remove("hidden");
    tabsEl.innerHTML = "";

    for (const path of this.openFiles) {
      const isActive = path === this.activeFile;
      const name = path.split("/").pop();

      const tab = el("button", {
        class: `tab${isActive ? " active" : ""}`,
        type: "button",
        role: "tab",
        "aria-selected": String(isActive),
        onclick: () => this.openFile(path),
      },
        el("span", { class: "tab-name" }, name),
        isActive && this.dirty ? el("span", { class: "tab-dirty" }) : null,
        el("button", {
          class: "tab-close",
          type: "button",
          "aria-label": `Close ${name}`,
          onclick: (e) => {
            e.stopPropagation();
            this.closeFile(path);
          },
        }, icon("x", 10))
      );

      tabsEl.appendChild(tab);
    }
  },

  async createFile (folderPath = "") {
    if (!this.currentProject) {
      toast("Open a project first", { type: "warning" });
      return;
    }
    const name = prompt("File name (e.g. index.html):");
    if (!name) return;
    const cleaned = name.trim().replace(/[^a-zA-Z0-9._/-]/g, "");
    if (!cleaned) return;
    const path = folderPath ? `${folderPath}/${cleaned}` : cleaned;
    const existing = await db.getFile(this.currentProject.pid, path);
    if (existing) {
      toast("File already exists", { type: "warning" });
      return;
    }
    await db.putFile(this.currentProject.pid, path, "");
    toast(`Created ${path}`, { type: "success" });
    await this.openFile(path);
    window.dispatchEvent(new CustomEvent("folio:file-created", {
      detail: { pid: this.currentProject.pid, path },
    }));
  },

  async createFolder (parentPath = "") {
    if (!this.currentProject) {
      toast("Open a project first", { type: "warning" });
      return;
    }
    const name = prompt("Folder name (e.g. src):");
    if (!name) return;
    const cleaned = name.trim().replace(/[^a-zA-Z0-9._-]/g, "");
    if (!cleaned) return;
    const folderPath = parentPath ? `${parentPath}/${cleaned}` : cleaned;
    const placeholderPath = `${folderPath}/.gitkeep`;
    const existing = await db.getFile(this.currentProject.pid, placeholderPath);
    if (existing) {
      toast("Folder already exists", { type: "warning" });
      return;
    }
    await db.putFile(this.currentProject.pid, placeholderPath, "");
    toast(`Created folder ${folderPath}`, { type: "success" });
    window.dispatchEvent(new CustomEvent("folio:file-created", {
      detail: { pid: this.currentProject.pid, path: placeholderPath },
    }));
  },

  async deleteFile (path) {
    if (!this.currentProject) return;
    const ok = await confirm({
      title: `Delete ${path.split("/").pop()}?`,
      message: "This file will be permanently deleted and cannot be recovered.",
      confirmLabel: "Delete file",
      danger: true,
    });
    if (!ok) return;
    await db.deleteFile(this.currentProject.pid, path);
    const idx = this.openFiles.indexOf(path);
    if (idx >= 0) this.openFiles.splice(idx, 1);
    if (this.activeFile === path) {
      this.activeFile = null;
      if (this.openFiles.length > 0) {
        await this.openFile(this.openFiles[this.openFiles.length - 1]);
      } else {
        this.showEmptyEditor();
        this.updateTabs();
      }
    } else {
      this.updateTabs();
    }
    toast("File deleted", { type: "info" });
    window.dispatchEvent(new CustomEvent("folio:file-deleted", {
      detail: { pid: this.currentProject.pid, path },
    }));
  },

  showEmptyEditor (message) {
    $("editorEmpty")?.classList.add("visible");
    const container = $("editorContainer");
    if (container) container.innerHTML = "";
    $("tabs")?.classList.add("hidden");
    if (message) {
      const titleEl = document.querySelector(".editor-empty-title");
      if (titleEl) titleEl.textContent = message;
    }
    cm.destroy();
  },

  hideEmptyEditor () {
    $("editor-empty")?.classList.remove("visible");
    $("editorEmpty")?.classList.remove("visible");
  },
};