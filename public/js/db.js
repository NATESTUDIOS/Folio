// public/js/db.js
// ═══════════════════════════════════════════════════════════════════════
//  FOLIO — Storage
//  The only module that touches IndexedDB.
// ═══════════════════════════════════════════════════════════════════════

import { formatBytes, STORAGE_KEYS } from "./shared.js";


export const LIMITS = {
  defaultProjectBytes: 10 * 1024 * 1024,
  versionRetentionDays: 30,
  versionRetentionCount: 50,
  cleanupThreshold: 0.9,
  cleanupTarget: 0.7,
  maxFileSizeBytes: 2 * 1024 * 1024,
};

export class QuotaError extends Error {
  constructor (message) {
    super(message);
    this.name = "QuotaError";
  }
}


/* ── IndexedDB ── */

const DB_NAME = "folio";
const DB_VERSION = 1;

const STORES = {
  projects: "projects",
  files: "files",
  versions: "versions",
  projectMeta: "projectMeta",
  settings: "settings",
  syncQueue: "syncQueue",
  profile: "profile",
  notificationPrefs: "notificationPrefs",
};

export const db = {
  _conn: null,

  async open () {
    if (this._conn) return this._conn;

    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);

      req.onerror = () => reject(req.error);
      req.onsuccess = () => {
        this._conn = req.result;
        resolve(this._conn);
      };

      req.onupgradeneeded = (event) => {
        const conn = event.target.result;

        if (!conn.objectStoreNames.contains(STORES.projects)) {
          const store = conn.createObjectStore(STORES.projects, { keyPath: "pid" });
          store.createIndex("updatedAt", "updatedAt");
        }
        if (!conn.objectStoreNames.contains(STORES.files)) {
          const store = conn.createObjectStore(STORES.files, { keyPath: ["pid", "path"] });
          store.createIndex("pid", "pid");
        }
        if (!conn.objectStoreNames.contains(STORES.versions)) {
          const store = conn.createObjectStore(STORES.versions, { keyPath: "vid" });
          store.createIndex("pid", "pid");
          store.createIndex("createdAt", "createdAt");
        }
        if (!conn.objectStoreNames.contains(STORES.projectMeta)) {
          conn.createObjectStore(STORES.projectMeta, { keyPath: "pid" });
        }
        if (!conn.objectStoreNames.contains(STORES.settings)) {
          conn.createObjectStore(STORES.settings, { keyPath: "key" });
        }
        if (!conn.objectStoreNames.contains(STORES.syncQueue)) {
          const store = conn.createObjectStore(STORES.syncQueue, { keyPath: "id", autoIncrement: true });
          store.createIndex("ts", "ts");
        }
        if (!conn.objectStoreNames.contains(STORES.profile)) {
          conn.createObjectStore(STORES.profile, { keyPath: "key" });
        }
        if (!conn.objectStoreNames.contains(STORES.notificationPrefs)) {
          conn.createObjectStore(STORES.notificationPrefs, { keyPath: "key" });
        }
      };
    });
  },

  _tx (storeName, mode = "readonly") {
    return this._conn.transaction(storeName, mode).objectStore(storeName);
  },

  _wrap (req) {
    return new Promise((resolve, reject) => {
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  },

  async listProjects () {
    const all = await this._wrap(this._tx(STORES.projects).getAll());
    return all.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  },

  async getProject (pid) {
    return this._wrap(this._tx(STORES.projects).get(pid));
  },

  async putProject (project) {
    return this._wrap(this._tx(STORES.projects, "readwrite").put(project));
  },

  async deleteProject (pid) {
    await this._wrap(this._tx(STORES.projects, "readwrite").delete(pid));
    const files = await this._wrap(this._tx(STORES.files).index("pid").getAll(pid));
    for (const f of files) {
      await this._wrap(this._tx(STORES.files, "readwrite").delete([f.pid, f.path]));
    }
    const versions = await this._wrap(this._tx(STORES.versions).index("pid").getAll(pid));
    for (const v of versions) {
      await this._wrap(this._tx(STORES.versions, "readwrite").delete(v.vid));
    }
    await this._wrap(this._tx(STORES.projectMeta, "readwrite").delete(pid));
  },

  async listFiles (pid) {
    return this._wrap(this._tx(STORES.files).index("pid").getAll(pid));
  },

  async getFile (pid, path) {
    return this._wrap(this._tx(STORES.files).get([pid, path]));
  },

  async putFile (pid, path, content, opts = {}) {
    const existing = await this.getFile(pid, path);
    const record = {
      pid,
      path,
      content,
      isPublic: opts.isPublic ?? existing?.isPublic ?? false,
      updatedAt: Date.now(),
    };
    return this._wrap(this._tx(STORES.files, "readwrite").put(record));
  },

  async deleteFile (pid, path) {
    return this._wrap(this._tx(STORES.files, "readwrite").delete([pid, path]));
  },

  async listVersions (pid) {
    const all = await this._wrap(this._tx(STORES.versions).index("pid").getAll(pid));
    return all.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  },

  async getVersion (vid) {
    return this._wrap(this._tx(STORES.versions).get(vid));
  },

  async putVersion (version) {
    return this._wrap(this._tx(STORES.versions, "readwrite").put(version));
  },

  async deleteVersion (vid) {
    return this._wrap(this._tx(STORES.versions, "readwrite").delete(vid));
  },

  async getProjectMeta (pid) {
    const m = await this._wrap(this._tx(STORES.projectMeta).get(pid));
    return m || {
      pid,
      notepad: "",
      cleanupPolicy: {
        retentionDays: LIMITS.versionRetentionDays,
        retentionCount: LIMITS.versionRetentionCount,
      },
      lastCleanupAt: 0,
    };
  },

  async setProjectMeta (pid, patch) {
    const current = await this.getProjectMeta(pid);
    const merged = { ...current, ...patch, pid };
    return this._wrap(this._tx(STORES.projectMeta, "readwrite").put(merged));
  },

  async getSetting (key) {
    const r = await this._wrap(this._tx(STORES.settings).get(key));
    return r?.value;
  },

  async putSetting (key, value) {
    return this._wrap(this._tx(STORES.settings, "readwrite").put({ key, value }));
  },

  async enqueueSync (op) {
    return this._wrap(this._tx(STORES.syncQueue, "readwrite").add({ ...op, ts: Date.now() }));
  },

  async listSyncQueue () {
    const all = await this._wrap(this._tx(STORES.syncQueue).getAll());
    return all.sort((a, b) => a.ts - b.ts);
  },

  async deleteSyncItem (id) {
    return this._wrap(this._tx(STORES.syncQueue, "readwrite").delete(id));
  },
};


/* ── Settings ── */

export const settings = {
  fontSize: 14,
  tabSize: 2,
  lineNumbers: true,
  wordWrap: true,

  load () {
    try {
      const raw = localStorage.getItem(STORAGE_KEYS.settings);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (typeof parsed.fontSize === "number") this.fontSize = parsed.fontSize;
        if (typeof parsed.tabSize === "number") this.tabSize = parsed.tabSize;
        if (typeof parsed.lineNumbers === "boolean") this.lineNumbers = parsed.lineNumbers;
        if (typeof parsed.wordWrap === "boolean") this.wordWrap = parsed.wordWrap;
      }
    } catch {}
  },

  save () {
    try {
      localStorage.setItem(STORAGE_KEYS.settings, JSON.stringify({
        fontSize: this.fontSize,
        tabSize: this.tabSize,
        lineNumbers: this.lineNumbers,
        wordWrap: this.wordWrap,
      }));
    } catch {}
  },
};


/* ── Quota ── */

export async function estimateQuota () {
  if (!navigator.storage?.estimate) return { usage: 0, quota: 0, percent: 0 };
  try {
    const est = await navigator.storage.estimate();
    const usage = est.usage || 0;
    const quota = est.quota || 0;
    return { usage, quota, percent: quota > 0 ? usage / quota : 0 };
  } catch {
    return { usage: 0, quota: 0, percent: 0 };
  }
}

export async function requestPersistentStorage () {
  if (!navigator.storage?.persist) return false;
  try {
    return await navigator.storage.persist();
  } catch {
    return false;
  }
}

export async function guardedWrite (fn, opts = {}) {
  if (opts.estimatedBytes && opts.estimatedBytes > LIMITS.maxFileSizeBytes) {
    throw new QuotaError(`File exceeds ${formatBytes(LIMITS.maxFileSizeBytes)} limit`);
  }
  try {
    return await fn();
  } catch (err) {
    if (err?.name === "QuotaExceededError") {
      throw new QuotaError("Device storage is full. Clean up old versions or files.");
    }
    throw err;
  }
}


/* ── Cleanup ── */

export const cleanup = {
  async maybeRun (pid) {
    if (!pid) return;
    const meta = await db.getProjectMeta(pid);
    const last = meta.lastCleanupAt || 0;
    if (Date.now() - last < 24 * 60 * 60 * 1000) return;
    await this.runPolicy(pid);
  },

  async runPolicy (pid) {
    const meta = await db.getProjectMeta(pid);
    const policy = meta.cleanupPolicy || {};
    const retentionDays = policy.retentionDays || LIMITS.versionRetentionDays;
    const retentionCount = policy.retentionCount || LIMITS.versionRetentionCount;

    const versions = await db.listVersions(pid);
    if (versions.length === 0) {
      await db.setProjectMeta(pid, { lastCleanupAt: Date.now() });
      return;
    }

    const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
    const toDelete = [];
    const kept = [];

    for (let i = 0; i < versions.length; i++) {
      const v = versions[i];
      if (i === 0) { kept.push(v); continue; }
      if (kept.length < retentionCount && (v.createdAt || 0) >= cutoff) {
        kept.push(v);
      } else {
        toDelete.push(v);
      }
    }

    for (const v of toDelete) {
      await db.deleteVersion(v.vid);
    }

    await db.setProjectMeta(pid, { lastCleanupAt: Date.now() });
  },

  async forceCleanup (pid) {
    await db.setProjectMeta(pid, { lastCleanupAt: 0 });
    await this.runPolicy(pid);
  },
};


/* ── Transfer ── */

export const transfer = {
  async exportFile (pid, path) {
    const file = await db.getFile(pid, path);
    if (!file) return false;
    const blob = new Blob([file.content], { type: "text/plain" });
    this._download(blob, path.split("/").pop());
    return true;
  },

  async exportProject (pid) {
    const project = await db.getProject(pid);
    if (!project) return false;
    const files = await db.listFiles(pid);
    const data = {
      name: project.name,
      slug: project.slug,
      description: project.description,
      exportedAt: Date.now(),
      files: files.reduce((acc, f) => {
        acc[f.path] = f.content;
        return acc;
      }, {}),
    };
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    this._download(blob, `${project.slug || project.name}.folio.json`);
    return true;
  },

  async exportFullBackup () {
    const projects = await db.listProjects();
    const backup = {
      version: 1,
      exportedAt: Date.now(),
      projects: [],
    };
    for (const project of projects) {
      const files = await db.listFiles(project.pid);
      const versions = await db.listVersions(project.pid);
      const meta = await db.getProjectMeta(project.pid);
      backup.projects.push({
        project,
        files: files.map(f => ({ path: f.path, content: f.content, isPublic: f.isPublic })),
        versions,
        meta,
      });
    }
    const blob = new Blob([JSON.stringify(backup, null, 2)], { type: "application/json" });
    this._download(blob, `folio-backup-${new Date().toISOString().slice(0, 10)}.json`);
    return true;
  },

  async importFile (pid) {
    return new Promise((resolve) => {
      const input = document.createElement("input");
      input.type = "file";
      input.accept = "*/*";
      input.onchange = async () => {
        const file = input.files?.[0];
        if (!file) return resolve(false);
        try {
          const content = await file.text();
          await db.putFile(pid, file.name, content);
          resolve({ path: file.name, name: file.name });
        } catch {
          resolve(false);
        }
      };
      input.click();
    });
  },

  async importBackup (onConfirm) {
    return new Promise((resolve) => {
      const input = document.createElement("input");
      input.type = "file";
      input.accept = ".json";
      input.onchange = async () => {
        const file = input.files?.[0];
        if (!file) return resolve(false);
        try {
          const text = await file.text();
          const data = JSON.parse(text);
          if (!data.projects || !Array.isArray(data.projects)) {
            return resolve({ error: "Invalid backup file" });
          }
          const ok = onConfirm ? await onConfirm(data.projects.length) : true;
          if (!ok) return resolve(false);
          for (const entry of data.projects) {
            await db.putProject(entry.project);
            for (const f of entry.files || []) {
              await db.putFile(entry.project.pid, f.path, f.content, { isPublic: f.isPublic });
            }
            for (const v of entry.versions || []) {
              await db.putVersion(v);
            }
            if (entry.meta) {
              await db.setProjectMeta(entry.project.pid, entry.meta);
            }
          }
          resolve({ count: data.projects.length });
        } catch {
          resolve({ error: "Backup file is invalid" });
        }
      };
      input.click();
    });
  },

  _download (blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  },
};


/* ── Profile ── */

export const profile = {
  async get () {
    const r = await db._wrap(db._tx(STORES.profile).get("main"));
    return r?.value || {
      displayName: "",
      bio: "",
      avatarUrl: null,
      links: {},
    };
  },

  async update (patch) {
    const current = await this.get();
    const merged = { ...current, ...patch };
    await db._wrap(db._tx(STORES.profile, "readwrite").put({ key: "main", value: merged }));
    return merged;
  },
};


/* ── Analytics ── */

export const analytics = {
  async getProjectStats (pid) {
    const files = await db.listFiles(pid);
    const versions = await db.listVersions(pid);
    let totalBytes = 0;
    const fileSizes = files.map(f => {
      const size = f.content.length;
      totalBytes += size;
      return { path: f.path, size };
    });
    fileSizes.sort((a, b) => b.size - a.size);
    return {
      fileCount: files.length,
      versionCount: versions.length,
      totalBytes,
      largestFiles: fileSizes.slice(0, 10),
      oldestVersions: versions.slice(-5).reverse(),
    };
  },

  async getGlobalStats () {
    const projects = await db.listProjects();
    let totalBytes = 0;
    let totalFiles = 0;
    let totalVersions = 0;
    const perProject = [];

    for (const p of projects) {
      const files = await db.listFiles(p.pid);
      const versions = await db.listVersions(p.pid);
      let size = 0;
      for (const f of files) size += f.content.length;
      totalBytes += size;
      totalFiles += files.length;
      totalVersions += versions.length;
      perProject.push({
        pid: p.pid,
        name: p.name,
        bytes: size,
        fileCount: files.length,
        versionCount: versions.length,
        updatedAt: p.updatedAt,
      });
    }

    perProject.sort((a, b) => b.bytes - a.bytes);

    return {
      projectCount: projects.length,
      fileCount: totalFiles,
      versionCount: totalVersions,
      totalBytes,
      perProject,
    };
  },
};


/* ── Notification prefs ── */

export const notificationPrefs = {
  DEFAULTS: {
    pushEnabled: false,
    systemAlerts: true,
    analyticsAlerts: true,
    dbAlerts: true,
    storageAlerts: true,
    projectAlerts: true,
    inviteAlerts: true,
    quietHours: { enabled: false, start: "22:00", end: "07:00" },
  },

  async get () {
    const r = await db._wrap(db._tx(STORES.notificationPrefs).get("main"));
    return r?.value || { ...this.DEFAULTS };
  },

  async update (patch) {
    const current = await this.get();
    const merged = { ...current, ...patch };
    await db._wrap(db._tx(STORES.notificationPrefs, "readwrite").put({ key: "main", value: merged }));
    return merged;
  },
};