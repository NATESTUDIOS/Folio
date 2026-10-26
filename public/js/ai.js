// js/ai.js
// ═══════════════════════════════════════════════════════════════════
//  Folio AI — page-support module for ai.html
//  ────────────────────────────────────────────────────────────────
//  This module provides ALL the plumbing ai.html needs. It does not
//  render any UI chrome, inject styles, or manage the DOM beyond the
//  helpers exposed below. ai-page.js (the page controller) consumes
//  these exports and builds the interface.
//
//  Storage contract (matches index.html and project.html exactly):
//
//    • Notes         → IDB 'files' store, key [pid, 'notes.json']
//                      shape: { version: 1, notes: [ { id, title, body,
//                      color, pinned, createdAt, updatedAt,
//                      sourceRunId?, sourceTask?, sourceFile? } ] }
//                      Hidden from the file tree via isSystemFile().
//                      Syncs through project/sync-back like any file.
//
//    • AI runs       → IDB 'projectMeta' store, key pid, field .ai
//                      shape: { version: 1, runs: [...], pending: [...],
//                      quota: {...}, lastUpdated }
//                      Local-only. Does not sync. Does not count toward
//                      project storage. Invisible to the editor.
//
//    • Quota mirror  → localStorage 'folio.ai.quota' (fast path for the
//                      HUD before any call has fired this session)
//
//    • Result cache  → in-memory Map, 10min TTL, 40 entries
//
//  Server contract (api/ai.js):
//
//    POST /api/ai { task, pid?, payload }
//      success → { success, task, text, artifacts, usage, guest, cached,
//                  quota: { wordsUsed, wordsLimit, creditsUsed,
//                          creditsLimit, resetAt },
//                  rateLimit: { limit, remaining, reset } }
//      failure → { success: false, error, scope, limit, used, resetAt,
//                  retryAfter, guest }
//
//  Client → server task alias (server task names differ for host tasks):
//      'commitDraft' → 'commitChanges'
//      'deployDraft' → 'writeDeploy'
//
//  No DOM. No CSS. No global listeners. Every function is pure or
//  storage-bound. ai-page.js wires events.
// ═══════════════════════════════════════════════════════════════════

"use strict";

// =========================================================================
// CONFIG
// =========================================================================

const API_BASE = (typeof window !== "undefined" && window.FOLIO_API_BASE)
  || "https://foliostudios.vercel.app/api";
const API_AI = API_BASE + "/ai";

const NOTES_PATH = "notes.json";
const NOTES_MAX_COUNT = 200;
const NOTES_MAX_BODY_BYTES = 200 * 1024;

const AI_STATE_VERSION = 1;
const AI_RUNS_MAX = 50;
const AI_PENDING_TTL_MS = 24 * 60 * 60 * 1000;

const RESULT_CACHE_MAX = 40;
const RESULT_CACHE_TTL_MS = 10 * 60 * 1000;
const QUOTA_STORAGE_KEY = "folio.ai.quota";

// Lazy asset URLs — Mermaid and KaTeX load only when a placeholder exists.
const MERMAID_URL = "https://cdn.jsdelivr.net/npm/mermaid@10.9.1/dist/mermaid.min.js";
const KATEX_CSS = "https://cdn.jsdelivr.net/npm/katex@0.16.9/dist/katex.min.css";
const KATEX_JS = "https://cdn.jsdelivr.net/npm/katex@0.16.9/dist/katex.min.js";

// Guest-allowable tasks (mirrors server GUEST_ALLOWED_TASKS)
const GUEST_TASKS = new Set([
  "explain", "logExplain", "metatags", "brainstorm", "diagram",
]);

// Host tasks (server HOST_TASKS)
const HOST_TASKS = new Set(["readProject", "commitChanges", "writeDeploy"]);

// Tasks whose artifacts are worth staging for later accept
const APPLY_TASKS = new Set([
  "debug", "codefix", "optimize", "suggest", "docstrings", "audit",
  "scaffold", "translate", "findFn",
]);

// =========================================================================
// TASK METADATA
// Mirrors api/ai.js TASK_LIMITS exactly. Weights are used by the page to
// show "· N credits" next to expensive tasks and by the HUD to project
// budget impact. Labels use plain language (non-technical user facing).
// =========================================================================

const TASK_META = {
  explain:       { label: "What does this do?",  sub: "explain",       group: "Understand", weight: 1, requiresPid: false, requiresEditor: false, writes: false },
  debug:         { label: "Find bugs",           sub: "debug",         group: "Fix",        weight: 3, requiresPid: false, requiresEditor: false, writes: true  },
  codefix:       { label: "Fix this",            sub: "codefix",       group: "Fix",        weight: 3, requiresPid: false, requiresEditor: false, writes: true  },
  optimize:      { label: "Make it faster",      sub: "optimize",      group: "Fix",        weight: 3, requiresPid: false, requiresEditor: false, writes: true  },
  suggest:       { label: "Suggest next line",   sub: "suggest",       group: "Complete",   weight: 1, requiresPid: false, requiresEditor: false, writes: true  },
  brainstorm:    { label: "Brainstorm ideas",    sub: "brainstorm",    group: "Design",     weight: 2, requiresPid: false, requiresEditor: false, writes: false },
  metatags:      { label: "SEO tags",            sub: "metatags",      group: "Content",    weight: 1, requiresPid: false, requiresEditor: false, writes: false },
  scaffold:      { label: "Build starter",       sub: "scaffold",      group: "Build",      weight: 8, requiresPid: false, requiresEditor: false, writes: true  },
  docs:          { label: "Write documentation", sub: "docs",          group: "Document",   weight: 8, requiresPid: false, requiresEditor: false, writes: true  },
  findFn:        { label: "Find a function",     sub: "findFn",        group: "Refactor",   weight: 5, requiresPid: false, requiresEditor: false, writes: true  },
  commitMsg:     { label: "Write commit message",sub: "commitMsg",     group: "Meta",       weight: 1, requiresPid: false, requiresEditor: false, writes: false },
  logExplain:    { label: "Explain this error",  sub: "logExplain",    group: "Debug",      weight: 1, requiresPid: false, requiresEditor: false, writes: false },
  diagram:       { label: "Draw a diagram",      sub: "diagram",       group: "Understand", weight: 2, requiresPid: false, requiresEditor: false, writes: false },
  simulate:      { label: "Trace step-by-step",  sub: "simulate",      group: "Understand", weight: 3, requiresPid: false, requiresEditor: false, writes: false },
  designExplain: { label: "Explain architecture",sub: "designExplain", group: "Understand", weight: 6, requiresPid: false, requiresEditor: false, writes: false },
  translate:     { label: "Translate",           sub: "translate",     group: "Convert",    weight: 3, requiresPid: false, requiresEditor: false, writes: true  },
  docstrings:    { label: "Add comments",        sub: "docstrings",    group: "Document",   weight: 1, requiresPid: false, requiresEditor: false, writes: true  },
  struggle:      { label: "Find weak spots",     sub: "struggle",      group: "Diagnose",   weight: 4, requiresPid: false, requiresEditor: false, writes: false },
  audit:         { label: "Check accessibility & security", sub: "audit", group: "Secure",   weight: 3, requiresPid: false, requiresEditor: false, writes: true  },
  readProject:   { label: "Summarize project",   sub: "readProject",   group: "Host",       weight: 5, requiresPid: true,  requiresEditor: true,  writes: false },
  commitDraft:   { label: "Draft commit",        sub: "commitDraft",   group: "Host",       weight: 2, requiresPid: true,  requiresEditor: true,  writes: false, alias: "commitChanges" },
  deployDraft:   { label: "Draft deploy",        sub: "deployDraft",   group: "Host",       weight: 2, requiresPid: true,  requiresEditor: true,  writes: false, alias: "writeDeploy"   },
};

// =========================================================================
// UTILITY
// =========================================================================

function nowMs() { return Date.now(); }

function uid(prefix = "a") {
  return prefix + "_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 8);
}

function estimateSize(v) {
  if (typeof v === "string") return v.length;
  try { return JSON.stringify(v).length; } catch { return 0; }
}

function countWords(text) {
  if (!text) return 0;
  const m = String(text).match(/\S+/g);
  return m ? m.length : 0;
}

function canonicalize(v) {
  if (v === null || typeof v !== "object") return v;
  if (Array.isArray(v)) return v.map(canonicalize);
  const out = {};
  for (const k of Object.keys(v).sort()) out[k] = canonicalize(v[k]);
  return out;
}

function hashString(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h).toString(36);
}

function isOnline() {
  try { return navigator.onLine !== false; } catch { return true; }
}

// =========================================================================
// TASK LOOKUP
// =========================================================================

export function getTaskMeta(task) {
  return TASK_META[task] || null;
}

export function listTasks() {
  return Object.entries(TASK_META).map(([id, meta]) => ({ id, ...meta }));
}

export function listTaskGroups() {
  const groups = new Map();
  for (const [id, meta] of Object.entries(TASK_META)) {
    if (!groups.has(meta.group)) groups.set(meta.group, []);
    groups.get(meta.group).push({ id, ...meta });
  }
  return Array.from(groups.entries()).map(([name, tasks]) => ({ name, tasks }));
}

export function isGuestTask(task) {
  return GUEST_TASKS.has(task);
}

export function isHostTask(task) {
  if (HOST_TASKS.has(task)) return true;
  const meta = TASK_META[task];
  return !!(meta && meta.alias && HOST_TASKS.has(meta.alias));
}

export function isTaskAvailable(task, { online = isOnline(), guest = false, role = "owner" } = {}) {
  const meta = TASK_META[task];
  if (!meta) return false;
  if (!online) return false;
  if (guest && !GUEST_TASKS.has(task)) return false;
  if (meta.requiresEditor && role !== "owner" && role !== "editor") return false;
  return true;
}

// =========================================================================
// QUOTA CACHE (localStorage mirror)
// =========================================================================

export function readQuotaCache() {
  try {
    const raw = localStorage.getItem(QUOTA_STORAGE_KEY);
    if (!raw) return null;
    const v = JSON.parse(raw);
    if (!v || typeof v !== "object") return null;
    if (v.resetAt && new Date(v.resetAt).getTime() < Date.now()) {
      localStorage.removeItem(QUOTA_STORAGE_KEY);
      return null;
    }
    return v;
  } catch { return null; }
}

export function writeQuotaCache(quota) {
  if (!quota) return;
  try { localStorage.setItem(QUOTA_STORAGE_KEY, JSON.stringify(quota)); } catch {}
}

export function clearQuotaCache() {
  try { localStorage.removeItem(QUOTA_STORAGE_KEY); } catch {}
}

// =========================================================================
// RESULT CACHE (in-memory, per page load)
// =========================================================================

const RESULT_CACHE = new Map();

function resultCacheKey(pid, task, payload) {
  const raw = JSON.stringify({ pid: pid || null, task, payload: canonicalize(payload || {}) });
  return hashString(raw);
}

export function readResultCache(pid, task, payload) {
  const key = resultCacheKey(pid, task, payload);
  const entry = RESULT_CACHE.get(key);
  if (!entry) return null;
  if (nowMs() - entry.at > RESULT_CACHE_TTL_MS) {
    RESULT_CACHE.delete(key);
    return null;
  }
  return entry.value;
}

export function writeResultCache(pid, task, payload, value) {
  const key = resultCacheKey(pid, task, payload);
  if (RESULT_CACHE.size >= RESULT_CACHE_MAX) {
    const first = RESULT_CACHE.keys().next().value;
    if (first) RESULT_CACHE.delete(first);
  }
  RESULT_CACHE.set(key, { value, at: nowMs() });
}

// =========================================================================
// AI STATE (projectMeta.ai namespace)
//
// Shape:
//   {
//     version: 1,
//     lastUpdated: number,
//     runs: [ AiRun ],          // last AI_RUNS_MAX, newest first
//     pending: [ PendingItem ], // staged artifacts, oldest first
//     quota: { ... } | null,    // mirror of last server response
//   }
//
// AiRun:
//   {
//     id, task, pid, file, scope, createdAt,
//     text, artifacts,
//     usage: { promptTokens, completionTokens, totalTokens,
//              promptWords, completionWords, totalWords },
//     quota: { wordsUsed, wordsLimit, creditsUsed, creditsLimit, resetAt },
//     cached: boolean,
//     accepted: [artifactIndex],
//     rejected: [artifactIndex],
//     noteId: string | null,   // set when user saved / edited a note from this run
//   }
//
// PendingItem:
//   {
//     id, runId, artifactIndex, artifact, kind, task, createdAt,
//   }
//
// The deps object must provide:
//   deps.idb.getProjectMeta(pid)   → Promise<meta>
//   deps.idb.setProjectMeta(pid, patch) → Promise<void>
// =========================================================================

function blankAiState() {
  return {
    version: AI_STATE_VERSION,
    lastUpdated: nowMs(),
    runs: [],
    pending: [],
    quota: null,
  };
}

function normalizeAiState(raw) {
  if (!raw || typeof raw !== "object") return blankAiState();
  const runs = Array.isArray(raw.runs) ? raw.runs : [];
  const pending = Array.isArray(raw.pending) ? raw.pending : [];
  const cutoff = nowMs() - AI_PENDING_TTL_MS;
  return {
    version: AI_STATE_VERSION,
    lastUpdated: raw.lastUpdated || nowMs(),
    runs: runs
      .filter(r => r && typeof r === "object" && r.id && r.task)
      .slice(0, AI_RUNS_MAX)
      .map(r => ({
        id: r.id,
        task: r.task,
        pid: r.pid || null,
        file: r.file || null,
        scope: r.scope || "file",
        createdAt: r.createdAt || nowMs(),
        text: r.text || "",
        artifacts: Array.isArray(r.artifacts) ? r.artifacts : [],
        usage: r.usage || null,
        quota: r.quota || null,
        cached: !!r.cached,
        accepted: Array.isArray(r.accepted) ? r.accepted : [],
        rejected: Array.isArray(r.rejected) ? r.rejected : [],
        noteId: r.noteId || null,
      })),
    pending: pending
      .filter(p => p && typeof p === "object" && p.id && p.runId && (p.createdAt || 0) > cutoff)
      .map(p => ({
        id: p.id,
        runId: p.runId,
        artifactIndex: Number(p.artifactIndex) || 0,
        artifact: p.artifact || null,
        kind: p.kind || (p.artifact?.type || "unknown"),
        task: p.task || null,
        createdAt: p.createdAt || nowMs(),
      })),
    quota: raw.quota && typeof raw.quota === "object" ? raw.quota : null,
  };
}

export async function readAiState(pid, deps) {
  if (!pid) return blankAiState();
  try {
    const meta = await deps.idb.getProjectMeta(pid);
    return normalizeAiState(meta?.ai);
  } catch {
    return blankAiState();
  }
}

export async function writeAiState(pid, state, deps) {
  if (!pid) throw new Error("writeAiState: missing pid");
  const normalized = normalizeAiState(state);
  normalized.lastUpdated = nowMs();
  await deps.idb.setProjectMeta(pid, { ai: normalized });
  return normalized;
}

export async function patchAiState(pid, patch, deps) {
  const current = await readAiState(pid, deps);
  const next = { ...current, ...patch };
  return writeAiState(pid, next, deps);
}

export async function appendAiRun(pid, run, deps) {
  const state = await readAiState(pid, deps);
  const normalized = {
    id: run.id || uid("run"),
    task: run.task,
    pid,
    file: run.file || null,
    scope: run.scope || "file",
    createdAt: run.createdAt || nowMs(),
    text: run.text || "",
    artifacts: Array.isArray(run.artifacts) ? run.artifacts : [],
    usage: run.usage || null,
    quota: run.quota || null,
    cached: !!run.cached,
    accepted: [],
    rejected: [],
    noteId: null,
  };
  state.runs.unshift(normalized);
  if (state.runs.length > AI_RUNS_MAX) state.runs = state.runs.slice(0, AI_RUNS_MAX);
  if (run.quota) state.quota = run.quota;
  await writeAiState(pid, state, deps);
  return normalized;
}

export async function removeAiRun(pid, runId, deps) {
  const state = await readAiState(pid, deps);
  state.runs = state.runs.filter(r => r.id !== runId);
  state.pending = state.pending.filter(p => p.runId !== runId);
  await writeAiState(pid, state, deps);
  return state;
}

export async function updateAiRun(pid, runId, patch, deps) {
  const state = await readAiState(pid, deps);
  const idx = state.runs.findIndex(r => r.id === runId);
  if (idx < 0) return null;
  state.runs[idx] = { ...state.runs[idx], ...patch };
  await writeAiState(pid, state, deps);
  return state.runs[idx];
}

export async function stageArtifactsFromRun(pid, run, deps) {
  const state = await readAiState(pid, deps);
  const stageable = ["diff", "files"];
  const added = [];
  for (let i = 0; i < (run.artifacts || []).length; i++) {
    const a = run.artifacts[i];
    if (!a || !stageable.includes(a.type)) continue;
    const item = {
      id: uid("pend"),
      runId: run.id,
      artifactIndex: i,
      artifact: a,
      kind: a.type,
      task: run.task,
      createdAt: nowMs(),
    };
    state.pending.push(item);
    added.push(item);
  }
  if (added.length) await writeAiState(pid, state, deps);
  return added;
}

export async function removePendingItem(pid, pendingId, deps) {
  const state = await readAiState(pid, deps);
  state.pending = state.pending.filter(p => p.id !== pendingId);
  await writeAiState(pid, state, deps);
  return state;
}

export async function clearPending(pid, deps) {
  const state = await readAiState(pid, deps);
  state.pending = [];
  await writeAiState(pid, state, deps);
  return state;
}

export async function markRunArtifactAccepted(pid, runId, artifactIndex, deps) {
  const state = await readAiState(pid, deps);
  const run = state.runs.find(r => r.id === runId);
  if (!run) return null;
  if (!run.accepted.includes(artifactIndex)) run.accepted.push(artifactIndex);
  run.rejected = run.rejected.filter(i => i !== artifactIndex);
  state.pending = state.pending.filter(
    p => !(p.runId === runId && p.artifactIndex === artifactIndex)
  );
  await writeAiState(pid, state, deps);
  return run;
}

export async function markRunArtifactRejected(pid, runId, artifactIndex, deps) {
  const state = await readAiState(pid, deps);
  const run = state.runs.find(r => r.id === runId);
  if (!run) return null;
  if (!run.rejected.includes(artifactIndex)) run.rejected.push(artifactIndex);
  run.accepted = run.accepted.filter(i => i !== artifactIndex);
  state.pending = state.pending.filter(
    p => !(p.runId === runId && p.artifactIndex === artifactIndex)
  );
  await writeAiState(pid, state, deps);
  return run;
}

// =========================================================================
// NOTES (notes.json file — the canonical store)
// =========================================================================

export async function readNotes(pid, deps) {
  if (!pid) return { version: 1, notes: [] };
  try {
    const file = await deps.idb.getFile(pid, NOTES_PATH);
    const content = typeof file === "string" ? file : (file?.content || "");
    if (!content) return { version: 1, notes: [] };
    const parsed = JSON.parse(content);
    if (!parsed || !Array.isArray(parsed.notes)) return { version: 1, notes: [] };
    return { version: parsed.version || 1, notes: parsed.notes };
  } catch {
    return { version: 1, notes: [] };
  }
}

export async function writeNotes(pid, data, deps) {
  if (!pid) throw new Error("writeNotes: missing pid");
  if (!data || !Array.isArray(data.notes)) throw new Error("writeNotes: invalid data");
  if (data.notes.length > NOTES_MAX_COUNT) {
    throw new Error(`Too many notes (max ${NOTES_MAX_COUNT}).`);
  }
  for (const n of data.notes) {
    if (estimateSize(n.body || "") > NOTES_MAX_BODY_BYTES) {
      throw new Error(`Note "${n.title || "Untitled"}" is too large.`);
    }
  }
  const json = JSON.stringify({ version: data.version || 1, notes: data.notes }, null, 2);
  await deps.idb.putFile(pid, NOTES_PATH, json);
  return { version: data.version || 1, notes: data.notes };
}

/**
 * Save or update a note that came from an AI run.
 * If sourceRunId matches an existing note, it is updated in place.
 * Otherwise a new note is created.
 *
 * Returns { note, isNew }.
 */
export async function saveAiNote(pid, { sourceRunId, sourceTask, sourceFile, title, body, color = "amber" }, deps) {
  const data = await readNotes(pid, deps);
  let note = null;
  let isNew = false;

  if (sourceRunId) {
    note = data.notes.find(n => n.sourceRunId === sourceRunId) || null;
  }

  if (note) {
    note.title = title ?? note.title;
    note.body = body ?? note.body;
    note.color = color || note.color || "amber";
    note.updatedAt = nowMs();
  } else {
    note = {
      id: uid("note"),
      title: title || "AI note",
      body: body || "",
      color: color || "amber",
      pinned: false,
      createdAt: nowMs(),
      updatedAt: nowMs(),
      sourceRunId: sourceRunId || null,
      sourceTask: sourceTask || null,
      sourceFile: sourceFile || null,
    };
    data.notes.push(note);
    isNew = true;
  }

  await writeNotes(pid, data, deps);

  if (sourceRunId) {
    await updateAiRun(pid, sourceRunId, { noteId: note.id }, deps).catch(() => {});
  }

  return { note, isNew };
}

export async function deleteNote(pid, noteId, deps) {
  const data = await readNotes(pid, deps);
  data.notes = data.notes.filter(n => n.id !== noteId);
  await writeNotes(pid, data, deps);
  return data;
}

// =========================================================================
// TASK DISPATCH
// =========================================================================

/**
 * POST /api/ai with the given task. Never throws — always returns
 * { ok, status, data, headers }. Failure cases are encoded in `ok`
 * and `data.error`.
 *
 * The caller is responsible for translating `data.quota` into storage
 * (writeQuotaCache) and for persisting the run into projectMeta.ai.
 *
 * `deps.apiFetch` is optional; if omitted, a default fetch implementation
 * that reads `localStorage['folio.session']` for the Bearer token is used.
 */
export async function runTask({ task, pid = null, payload = {}, signal = null, deps = {} } = {}) {
  if (!task) {
    return { ok: false, status: 0, data: { success: false, error: "Missing task" }, headers: null };
  }
  const meta = TASK_META[task];
  if (!meta) {
    return { ok: false, status: 0, data: { success: false, error: `Unknown task: ${task}` }, headers: null };
  }
  if (meta.requiresPid && !pid) {
    return { ok: false, status: 0, data: { success: false, error: "Missing project id" }, headers: null };
  }
  if (!isOnline()) {
    return { ok: false, status: 0, data: { success: false, error: "Offline" }, headers: null };
  }

  const serverTask = meta.alias || task;
  const fetchImpl = deps.apiFetch
    || (typeof window !== "undefined" && typeof window.apiFetch === "function" ? window.apiFetch : null)
    || defaultFetch;

  try {
    const res = await fetchImpl(API_AI, {
      method: "POST",
      body: JSON.stringify({ task: serverTask, pid: pid || null, payload }),
      signal: signal || undefined,
    });

    if (res?.data?.quota) writeQuotaCache(res.data.quota);

    if (!res.ok && res.data && res.data.scope) {
      res.data.quotaExceeded = ["words", "credits", "global", "per_task"].includes(res.data.scope);
    }

    return res;
  } catch (err) {
    if (err?.name === "AbortError") {
      return { ok: false, status: 0, data: { success: false, error: "Cancelled" }, headers: null };
    }
    return { ok: false, status: 0, data: { success: false, error: String(err?.message || "Network error") }, headers: null };
  }
}

async function defaultFetch(url, opts = {}) {
  const headers = { "Content-Type": "application/json", ...(opts.headers || {}) };
  try {
    const session = localStorage.getItem("folio.session");
    if (session) headers["Authorization"] = `Bearer ${session}`;
  } catch {}
  try {
    const res = await fetch(url, { ...opts, headers });
    let data = {};
    try { data = await res.json(); } catch {}
    return { ok: res.ok, status: res.status, data, headers: res.headers };
  } catch (err) {
    return { ok: false, status: 0, data: { success: false, error: String(err?.message || "Network error") }, headers: null };
  }
}

// =========================================================================
// APPLY PATCH / FILES
// =========================================================================

async function readFileContent(pid, path, idb) {
  if (!idb || typeof idb.getFile !== "function") return null;
  try {
    const f = await idb.getFile(pid, path);
    if (f == null) return null;
    return typeof f === "string" ? f : (f.content || "");
  } catch { return null; }
}

async function writeFileContent(pid, path, content, idb) {
  if (!idb || typeof idb.putFile !== "function") return false;
  try { await idb.putFile(pid, path, content); return true; }
  catch { return false; }
}

/**
 * Apply a `diff` artifact. Verifies `old` is still present in the file
 * before writing — stale patches are rejected.
 *
 * Returns { ok, path, replaced, error }.
 */
export async function applyPatch({ artifact, pid, deps = {} } = {}) {
  if (!artifact || artifact.type !== "diff") {
    return { ok: false, error: "Not a diff artifact" };
  }
  if (!pid) return { ok: false, error: "Missing pid" };
  if (!artifact.file) return { ok: false, error: "Missing file path" };

  const idb = deps.idb;
  const current = await readFileContent(pid, artifact.file, idb);
  if (current == null) {
    return { ok: false, error: `File not found: ${artifact.file}` };
  }

  if (!artifact.old) {
    if (deps.replaceAll !== true) {
      return { ok: false, error: "Empty <old> — pass replaceAll to replace whole file" };
    }
    const written = await writeFileContent(pid, artifact.file, artifact.new || "", idb);
    if (!written) return { ok: false, error: "Write failed" };
    return { ok: true, path: artifact.file, replaced: true };
  }

  if (!current.includes(artifact.old)) {
    return { ok: false, error: "Patch is stale — the file changed since the AI ran" };
  }

  const updated = current.replace(artifact.old, artifact.new || "");
  const written = await writeFileContent(pid, artifact.file, updated, idb);
  if (!written) return { ok: false, error: "Write failed" };
  return { ok: true, path: artifact.file, replaced: false };
}

/**
 * Apply a `files` artifact (multiple files at once). Partial success is
 * possible. Returns { ok, results, okCount, total }.
 */
export async function applyFiles({ artifact, pid, deps = {} } = {}) {
  if (!artifact || artifact.type !== "files") {
    return { ok: false, error: "Not a files artifact" };
  }
  if (!pid) return { ok: false, error: "Missing pid" };
  if (!Array.isArray(artifact.files)) {
    return { ok: false, error: "Invalid files artifact" };
  }

  const idb = deps.idb;
  const results = [];
  for (const f of artifact.files) {
    if (!f || typeof f.path !== "string" || typeof f.content !== "string") {
      results.push({ path: f?.path || "(unknown)", ok: false, error: "Invalid entry" });
      continue;
    }
    const written = await writeFileContent(pid, f.path, f.content, idb);
    results.push({
      path: f.path,
      ok: written,
      error: written ? null : "Write failed",
    });
  }
  const okCount = results.filter(r => r.ok).length;
  return { ok: okCount > 0, results, okCount, total: results.length };
}

// =========================================================================
// HOST PREFILL HELPERS
// =========================================================================

export function prefillCommit({ artifact } = {}) {
  if (!artifact || artifact.type !== "commitDraft") return null;
  const parts = [artifact.message || ""];
  if (artifact.body) parts.push("", artifact.body);
  return {
    message: parts.join("\n").trim(),
    changed: Array.isArray(artifact.changed) ? artifact.changed : [],
  };
}

export function prefillDeploy({ artifact } = {}) {
  if (!artifact || artifact.type !== "deployDraft") return null;
  return {
    summary: artifact.summary || "Deploy",
    changed: Array.isArray(artifact.changed) ? artifact.changed : [],
    sinceDeploymentId: artifact.sinceDeploymentId || null,
  };
}

// =========================================================================
// LAZY ASSET LOADERS
// =========================================================================

let _mermaidPromise = null;
let _mermaidReady = false;

async function ensureMermaid() {
  if (_mermaidReady) return window.mermaid || null;
  if (_mermaidPromise) return _mermaidPromise;
  _mermaidPromise = import(/* @vite-ignore */ MERMAID_URL)
    .then(mod => {
      const m = mod.default || mod;
      if (typeof m.initialize === "function") {
        try {
          m.initialize({
            startOnLoad: false,
            theme: document.documentElement.hasAttribute("data-theme") ? "default" : "dark",
            themeVariables: { fontFamily: "Inter, system-ui, sans-serif" },
            securityLevel: "strict",
            flowchart: { htmlLabels: true, curve: "basis" },
          });
        } catch {}
      }
      window.mermaid = m;
      _mermaidReady = true;
      return m;
    })
    .catch(() => {
      _mermaidPromise = null;
      return null;
    });
  return _mermaidPromise;
}

let _katexPromise = null;
let _katexReady = false;

async function ensureKaTeX() {
  if (_katexReady) return window.katex || null;
  if (_katexPromise) return _katexPromise;
  _katexPromise = (async () => {
    if (!document.querySelector(`link[href="${KATEX_CSS}"]`)) {
      const link = document.createElement("link");
      link.rel = "stylesheet";
      link.href = KATEX_CSS;
      document.head.appendChild(link);
    }
    return import(/* @vite-ignore */ KATEX_JS).then(mod => {
      const k = mod.default || mod;
      window.katex = k;
      _katexReady = true;
      return k;
    });
  })().catch(() => {
    _katexPromise = null;
    return null;
  });
  return _katexPromise;
}

// =========================================================================
// MARKDOWN RENDERER
// =========================================================================

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, c => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

function stripFences(s) {
  return String(s || "")
    .replace(/^\uFEFF/, "")
    .replace(/^\s*```[a-zA-Z0-9_-]*\s*\n/, "")
    .replace(/\n\s*```\s*$/, "")
    .trim();
}

/**
 * Render markdown to HTML. Placeholders for Mermaid, KaTeX, and flowtable
 * are emitted with data-* attributes; hydrateMarkdown fills them in.
 */
export function renderMarkdown(text) {
  let src = String(text ?? "");

  const fences = [];
  src = src.replace(/```([a-zA-Z0-9_-]*)\s*\n([\s\S]*?)```/g, (m, lang, body) => {
    const idx = fences.length;
    fences.push({ lang: (lang || "").toLowerCase(), body });
    return `\u0000FENCE${idx}\u0000`;
  });

  src = src
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

  const inline = (s) => s
    .replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, '<img alt="$1" src="$2" loading="lazy">')
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>')
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/\*([^*]+)\*/g, "<em>$1</em>")
    .replace(/~~([^~]+)~~/g, "<del>$1</del>")
    .replace(/`([^`]+)`/g, "<code>$1</code>");

  const lines = src.split("\n");
  const out = [];
  let inUl = false, inOl = false, inBq = false;
  let inTable = false, tableAligns = [];

  const closeUl = () => { if (inUl) { out.push("</ul>"); inUl = false; } };
  const closeOl = () => { if (inOl) { out.push("</ol>"); inOl = false; } };
  const closeBq = () => { if (inBq) { out.push("</blockquote>"); inBq = false; } };
  const closeTable = () => {
    if (inTable) { out.push("</tbody></table>"); inTable = false; tableAligns = []; }
  };
  const closeAll = () => { closeUl(); closeOl(); closeBq(); closeTable(); };

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];

    const fenceMatch = raw.match(/^\s*\u0000FENCE(\d+)\u0000\s*$/);
    if (fenceMatch) {
      closeAll();
      const f = fences[+fenceMatch[1]];
      const lang = f.lang;
      if (lang === "mermaid" || lang === "mindmap") {
        out.push(`<div class="ai-diagram" data-diagram="mermaid" data-source="${escapeHtml(f.body)}"><pre>${escapeHtml(f.body)}</pre></div>`);
      } else if (lang === "flowtable") {
        out.push(`<div class="ai-flowtable" data-flowtable="${escapeHtml(f.body)}"><pre>${escapeHtml(f.body)}</pre></div>`);
      } else if (lang === "math") {
        out.push(`<div class="ai-math" data-math="${escapeHtml(f.body)}" data-display="1"><pre>${escapeHtml(f.body)}</pre></div>`);
      } else {
        out.push(`<pre><code class="lang-${escapeHtml(lang)}">${escapeHtml(f.body)}</code></pre>`);
      }
      continue;
    }

    const displayMath = raw.match(/^\s*\$\$([\s\S]+?)\$\$\s*$/);
    if (displayMath) {
      closeAll();
      out.push(`<div class="ai-math" data-math="${escapeHtml(displayMath[1])}" data-display="1"><pre>${escapeHtml(displayMath[1])}</pre></div>`);
      continue;
    }

    if (/^\s*$/.test(raw)) { closeAll(); continue; }

    if (/^\s*[-*_]{3,}\s*$/.test(raw)) { closeAll(); out.push("<hr>"); continue; }

    const h = raw.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      closeAll();
      out.push(`<h${h[1].length}>${inline(h[2])}</h${h[1].length}>`);
      continue;
    }

    const bq = raw.match(/^>\s?(.*)$/);
    if (bq) {
      closeUl(); closeOl(); closeTable();
      if (!inBq) { out.push("<blockquote>"); inBq = true; }
      out.push(`<p>${inline(bq[1])}</p>`);
      continue;
    } else { closeBq(); }

    const task = raw.match(/^\s*[-*]\s+\[([ xX])\]\s+(.*)$/);
    if (task) {
      closeOl(); closeTable();
      if (!inUl) { out.push('<ul class="task-list">'); inUl = true; }
      const checked = task[1].toLowerCase() === "x";
      out.push(`<li class="task-item${checked ? " done" : ""}"><span class="task-box">${checked ? "✓" : ""}</span>${inline(task[2])}</li>`);
      continue;
    } else if (inUl && !/^\s*[-*]\s+/.test(raw)) {
      closeUl();
    }

    const ul = raw.match(/^\s*[-*]\s+(.*)$/);
    if (ul) {
      closeOl(); closeTable();
      if (!inUl) { out.push("<ul>"); inUl = true; }
      out.push(`<li>${inline(ul[1])}</li>`);
      continue;
    }

    const ol = raw.match(/^\s*\d+\.\s+(.*)$/);
    if (ol) {
      closeUl(); closeTable();
      if (!inOl) { out.push("<ol>"); inOl = true; }
      out.push(`<li>${inline(ol[1])}</li>`);
      continue;
    } else if (inOl && !/^\s*\d+\.\s+/.test(raw)) {
      closeOl();
    }

    if (/^\s*\|.*\|\s*$/.test(raw) && i + 1 < lines.length && /^\s*\|[\s:|-]+\|\s*$/.test(lines[i + 1])) {
      closeAll();
      const headers = raw.split("|").slice(1, -1).map(c => c.trim());
      tableAligns = lines[i + 1].split("|").slice(1, -1).map(c => {
        const t = c.trim();
        if (t.startsWith(":") && t.endsWith(":")) return "center";
        if (t.endsWith(":")) return "right";
        return "left";
      });
      out.push(`<table class="ai-table"><thead><tr>${headers.map((h, idx) => `<th style="text-align:${tableAligns[idx] || "left"}">${inline(h)}</th>`).join("")}</tr></thead><tbody>`);
      inTable = true;
      i++;
      continue;
    }

    if (inTable) {
      if (/^\s*\|.*\|\s*$/.test(raw)) {
        const cells = raw.split("|").slice(1, -1).map(c => c.trim());
        out.push(`<tr>${cells.map((c, idx) => `<td style="text-align:${tableAligns[idx] || "left"}">${inline(c)}</td>`).join("")}</tr>`);
        continue;
      } else {
        closeTable();
      }
    }

    out.push(`<p>${inline(raw)}</p>`);
  }

  closeAll();
  return out.join("\n");
}

/**
 * Fill in Mermaid / KaTeX / flowtable placeholders produced by renderMarkdown.
 * Fails silently and leaves the fallback <pre> in place when a lazy
 * dependency can't be fetched (offline first load).
 */
export async function hydrateMarkdown(root) {
  if (!root) return;

  const diagrams = root.querySelectorAll('[data-diagram="mermaid"]:not([data-hydrated])');
  if (diagrams.length) {
    const m = await ensureMermaid();
    if (m) {
      let idx = 0;
      for (const node of diagrams) {
        const src = node.getAttribute("data-source") || "";
        node.setAttribute("data-hydrated", "1");
        if (!src.trim()) { node.classList.add("ai-diagram-error"); continue; }
        try {
          const id = `ai-mmd-${nowMs()}-${idx++}`;
          const { svg } = await m.render(id, src);
          node.innerHTML = svg;
          node.classList.add("ai-diagram-rendered");
        } catch (err) {
          node.classList.add("ai-diagram-error");
          node.setAttribute("title", String(err?.message || err));
        }
      }
    } else {
      for (const node of diagrams) node.classList.add("ai-diagram-offline");
    }
  }

  const maths = root.querySelectorAll("[data-math]:not([data-hydrated])");
  if (maths.length) {
    const k = await ensureKaTeX();
    if (k) {
      for (const node of maths) {
        const src = node.getAttribute("data-math") || "";
        const display = node.getAttribute("data-display") === "1";
        node.setAttribute("data-hydrated", "1");
        try {
          k.render(src, node, { displayMode: display, throwOnError: false });
          node.classList.add("ai-math-rendered");
        } catch {
          node.classList.add("ai-math-error");
        }
      }
    } else {
      for (const node of maths) node.classList.add("ai-math-offline");
    }
  }

  const flowtables = root.querySelectorAll("[data-flowtable]:not([data-hydrated])");
  if (flowtables.length) {
    for (const node of flowtables) {
      node.setAttribute("data-hydrated", "1");
      try {
        const spec = JSON.parse(node.getAttribute("data-flowtable") || "{}");
        node.innerHTML = renderFlowtable(spec);
        node.classList.add("ai-flowtable-rendered");
      } catch {
        node.classList.add("ai-flowtable-error");
      }
    }
  }
}

function renderFlowtable(spec) {
  if (!spec || !Array.isArray(spec.rows)) {
    return '<div class="ai-flowtable-empty">Invalid flowtable</div>';
  }
  const cols = Array.isArray(spec.columns) && spec.columns.length
    ? spec.columns
    : ["Step", "Condition", "Action", "Next"];
  const head = `<thead><tr>${cols.map(c => `<th>${escapeHtml(c)}</th>`).join("")}</tr></thead>`;
  const rows = spec.rows.map((r, i) => {
    const cells = Array.isArray(r) ? r : [];
    return `<tr class="ft-row ft-row-${i % 2 ? "alt" : "base"}">${cells.map(c => `<td>${escapeHtml(c)}</td>`).join("")}</tr>`;
  }).join("");
  return `<div class="ai-flowtable-wrap"><table class="ai-flowtable">${head}<tbody>${rows}</tbody></table></div>`;
}

// =========================================================================
// ARTIFACT RENDERERS
//
// Each renderer returns a DOM node. All nodes use class names defined in
// ai.css. ai-page.js appends these nodes to the result container.
// =========================================================================

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === "class") node.className = v;
    else if (k === "style" && typeof v === "object") Object.assign(node.style, v);
    else if (k.startsWith("on") && typeof v === "function") node.addEventListener(k.slice(2), v);
    else if (k === "dataset" && typeof v === "object") Object.assign(node.dataset, v);
    else if (v === true) node.setAttribute(k, "");
    else node.setAttribute(k, v);
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    node.appendChild(typeof c === "string" || typeof c === "number"
      ? document.createTextNode(String(c)) : c);
  }
  return node;
}

function severityBadge(sev) {
  const s = (sev || "info").toLowerCase();
  const label = s === "error" ? "ERROR" : s === "warning" ? "WARN" : "INFO";
  return el("span", { class: `finding-sev finding-sev-${s}` }, label);
}

function renderFindings(artifact) {
  const wrap = el("div", { class: "ai-findings" });
  const items = Array.isArray(artifact.findings) ? artifact.findings : [];
  if (!items.length) {
    wrap.appendChild(el("div", { class: "ai-empty" }, "No findings."));
    return wrap;
  }
  for (const f of items) {
    wrap.appendChild(el("div", { class: "finding" },
      el("div", { class: "finding-head" },
        severityBadge(f.severity),
        f.file ? el("span", { class: "finding-loc" }, f.file + (f.line ? ":" + f.line : "")) : null,
      ),
      el("div", { class: "finding-title" }, f.title || ""),
      f.detail ? el("div", { class: "finding-detail" }, f.detail) : null,
    ));
  }
  return wrap;
}

function renderDiff(artifact, opts = {}) {
  const wrap = el("div", { class: "ai-diff" });
  wrap.appendChild(el("div", { class: "diff-head" },
    el("span", { class: "diff-file" }, artifact.file || "diff"),
    el("span", { class: "diff-hint" }, "old → new"),
  ));

  const oldLines = String(artifact.old || "").split("\n");
  const newLines = String(artifact.new || "").split("\n");
  const max = Math.max(oldLines.length, newLines.length);

  let added = 0, removed = 0;

  const grid = el("div", { class: "diff-grid" });
  const oldCol = el("div", { class: "diff-col diff-col-old" });
  const newCol = el("div", { class: "diff-col diff-col-new" });

  oldCol.appendChild(el("div", { class: "diff-col-head" }, "Old"));
  newCol.appendChild(el("div", { class: "diff-col-head" }, "New"));

  for (let i = 0; i < max; i++) {
    const o = oldLines[i];
    const n = newLines[i];
    const same = o === n;

    if (same) {
      oldCol.appendChild(el("div", { class: "diff-row diff-eq" },
        el("span", { class: "diff-sign" }, " "),
        el("span", { class: "diff-line" }, o ?? ""),
      ));
      newCol.appendChild(el("div", { class: "diff-row diff-eq" },
        el("span", { class: "diff-sign" }, " "),
        el("span", { class: "diff-line" }, n ?? ""),
      ));
    } else {
      if (o !== undefined && o !== "") {
        removed++;
        oldCol.appendChild(el("div", { class: "diff-row diff-del" },
          el("span", { class: "diff-sign" }, "−"),
          el("span", { class: "diff-line" }, o),
        ));
      } else {
        oldCol.appendChild(el("div", { class: "diff-row diff-empty" }, ""));
      }
      if (n !== undefined && n !== "") {
        added++;
        newCol.appendChild(el("div", { class: "diff-row diff-add" },
          el("span", { class: "diff-sign" }, "+"),
          el("span", { class: "diff-line" }, n),
        ));
      } else {
        newCol.appendChild(el("div", { class: "diff-row diff-empty" }, ""));
      }
    }
  }

  grid.appendChild(oldCol);
  grid.appendChild(newCol);
  wrap.appendChild(grid);

  wrap.appendChild(el("div", { class: "diff-stats" },
    el("span", {}, `${added + removed} change${added + removed === 1 ? "" : "s"}`),
    el("span", { class: "diff-stat-add" }, `+${added}`),
    el("span", { class: "diff-stat-del" }, `−${removed}`),
  ));

  const actions = el("div", { class: "diff-actions" });
  actions.appendChild(el("button", {
    class: "btn btn-primary btn-sm", type: "button",
    onclick: () => opts.onAccept?.(artifact),
  }, "Accept patch"));
  actions.appendChild(el("button", {
    class: "btn btn-ghost btn-sm", type: "button",
    onclick: () => opts.onReject?.(artifact),
  }, "Reject"));
  wrap.appendChild(actions);

  return wrap;
}

function renderFiles(artifact, opts = {}) {
  const wrap = el("div", { class: "ai-files" });
  const files = Array.isArray(artifact.files) ? artifact.files : [];
  if (!files.length) {
    wrap.appendChild(el("div", { class: "ai-empty" }, "No files in this artifact."));
    return wrap;
  }

  wrap.appendChild(el("div", { class: "files-head" },
    el("span", null, `${files.length} file${files.length === 1 ? "" : "s"}`),
  ));

  const list = el("div", { class: "files-list" });
  for (const f of files) {
    const preview = String(f.content || "").slice(0, 200);
    list.appendChild(el("div", { class: "file-row" },
      el("div", { class: "file-row-head" },
        el("code", { class: "file-path" }, f.path || ""),
        el("span", { class: "file-bytes" }, `${estimateSize(f.content || "")} chars`),
      ),
      el("pre", { class: "file-preview" }, preview + (String(f.content || "").length > 200 ? "\n…" : "")),
    ));
  }
  wrap.appendChild(list);

  const actions = el("div", { class: "diff-actions" });
  actions.appendChild(el("button", {
    class: "btn btn-primary btn-sm", type: "button",
    onclick: () => opts.onAccept?.(artifact),
  }, `Accept all ${files.length} files`));
  actions.appendChild(el("button", {
    class: "btn btn-ghost btn-sm", type: "button",
    onclick: () => opts.onReject?.(artifact),
  }, "Reject"));
  wrap.appendChild(actions);
  return wrap;
}

function renderMentions(artifact, opts = {}) {
  const wrap = el("div", { class: "ai-mentions" });
  const items = Array.isArray(artifact.mentions) ? artifact.mentions : [];
  if (!items.length) {
    wrap.appendChild(el("div", { class: "ai-empty" }, "No mentions."));
    return wrap;
  }
  for (const m of items) {
    wrap.appendChild(el("button", {
      class: "mention",
      type: "button",
      dataset: { file: m.file || "", line: String(m.line || 0) },
      onclick: () => opts.onOpenFile?.(m.file, m.line),
    },
      el("span", { class: "mention-file" }, m.file || ""),
      el("span", { class: "mention-line" }, ":" + (m.line || "?")),
      el("span", { class: "mention-kind" }, m.kind || ""),
      el("span", { class: "mention-context" }, m.context || ""),
    ));
  }
  return wrap;
}

function renderConcepts(artifact) {
  const wrap = el("div", { class: "ai-concepts" });
  const items = Array.isArray(artifact.concepts) ? artifact.concepts : [];
  if (!items.length) {
    wrap.appendChild(el("div", { class: "ai-empty" }, "No concepts."));
    return wrap;
  }
  for (const c of items) {
    wrap.appendChild(el("div", { class: "concept" },
      el("div", { class: "concept-kind" }, c.kind || ""),
      el("div", { class: "concept-title" }, c.title || ""),
      el("div", { class: "concept-detail" }, c.detail || ""),
    ));
  }
  return wrap;
}

function renderSteps(artifact) {
  const wrap = el("div", { class: "ai-steps" });
  const steps = Array.isArray(artifact.steps) ? artifact.steps : [];
  if (!steps.length) {
    wrap.appendChild(el("div", { class: "ai-empty" }, "No steps."));
    return wrap;
  }
  for (const s of steps) {
    const row = el("div", { class: "step-row" });
    row.appendChild(el("span", { class: "step-num" }, String(s.n || "?")));
    row.appendChild(el("span", { class: "step-line" }, "L" + (s.line || "?")));
    const body = el("div", { class: "step-body" });
    if (s.note) body.appendChild(el("div", { class: "step-note" }, s.note));
    if (s.state) body.appendChild(el("pre", { class: "step-state" }, JSON.stringify(s.state, null, 2)));
    if (s.return !== undefined) {
      body.appendChild(el("div", { class: "step-return" }, "returns " + JSON.stringify(s.return)));
    }
    row.appendChild(body);
    wrap.appendChild(row);
  }
  return wrap;
}

function renderTree(artifact) {
  const wrap = el("div", { class: "ai-tree" });
  if (!artifact.root) {
    wrap.appendChild(el("div", { class: "ai-empty" }, "No tree data."));
    return wrap;
  }
  const build = (node, depth) => {
    const li = el("li", { class: `tree-node-depth-${depth}` });
    li.appendChild(el("span", { class: "tree-label" }, node.label || ""));
    const children = Array.isArray(node.children) ? node.children : [];
    if (children.length) {
      const ul = el("ul");
      for (const c of children) ul.appendChild(build(c, depth + 1));
      li.appendChild(ul);
    }
    return li;
  };
  const ul = el("ul", { class: "tree-root" });
  ul.appendChild(build(artifact.root, 0));
  wrap.appendChild(ul);
  return wrap;
}

function renderJson(artifact, opts = {}) {
  const wrap = el("div", { class: "ai-json" });
  wrap.appendChild(el("pre", { class: "json-body" }, JSON.stringify(artifact.data, null, 2)));
  if (opts.task) wrap.setAttribute("data-task", opts.task);
  return wrap;
}

function renderCommitDraft(artifact, opts = {}) {
  const wrap = el("div", { class: "ai-commit-draft" });
  wrap.appendChild(el("div", { class: "draft-title" }, artifact.message || ""));
  if (artifact.body) wrap.appendChild(el("pre", { class: "draft-body" }, artifact.body));
  if (Array.isArray(artifact.changed) && artifact.changed.length) {
    wrap.appendChild(el("div", { class: "draft-changed" },
      el("span", { class: "draft-changed-label" }, "Files:"),
      ...artifact.changed.map(p => el("code", { class: "draft-changed-file" }, p)),
    ));
  }
  wrap.appendChild(el("button", {
    class: "btn btn-primary btn-sm", type: "button",
    onclick: () => opts.onPrefillCommit?.(prefillCommit({ artifact })),
  }, "Use this message"));
  return wrap;
}

function renderDeployDraft(artifact, opts = {}) {
  const wrap = el("div", { class: "ai-deploy-draft" });
  wrap.appendChild(el("div", { class: "draft-title" }, artifact.summary || "Deploy"));
  if (Array.isArray(artifact.changed) && artifact.changed.length) {
    wrap.appendChild(el("div", { class: "draft-changed" },
      el("span", { class: "draft-changed-label" }, "Changed:"),
      ...artifact.changed.map(p => el("code", { class: "draft-changed-file" }, p)),
    ));
  }
  wrap.appendChild(el("button", {
    class: "btn btn-primary btn-sm", type: "button",
    onclick: () => opts.onPrefillDeploy?.(prefillDeploy({ artifact })),
  }, "Use this summary"));
  return wrap;
}

function renderProjectSummary(artifact) {
  const wrap = el("div", { class: "ai-project-summary" });
  const insights = Array.isArray(artifact.insights) ? artifact.insights : [];
  if (insights.length) {
    wrap.appendChild(el("div", { class: "summary-section-title" }, "Insights"));
    const ul = el("ul", { class: "summary-insights" });
    for (const line of insights) ul.appendChild(el("li", null, line));
    wrap.appendChild(ul);
  }
  if (artifact.architectureSummary) {
    wrap.appendChild(el("div", { class: "summary-section-title" }, "Architecture"));
    wrap.appendChild(el("p", { class: "summary-arch" }, artifact.architectureSummary));
  }
  return wrap;
}

/**
 * Render an array of artifacts into `root`. Each artifact gets its own
 * card. Order is preserved. opts callbacks:
 *   onAccept(artifact, index)
 *   onReject(artifact, index)
 *   onPrefillCommit(prefill)
 *   onPrefillDeploy(prefill)
 *   onOpenFile(path, line)
 *   task: task id (used for json artifact hinting)
 */
export function renderArtifacts(root, artifacts, opts = {}) {
  if (!root) return;
  const list = Array.isArray(artifacts) ? artifacts : [];
  list.forEach((a, index) => {
    if (!a || !a.type) return;
    let node = null;
    const optsWithIndex = {
      ...opts,
      onAccept: (art) => opts.onAccept?.(art, index),
      onReject: (art) => opts.onReject?.(art, index),
    };
    switch (a.type) {
      case "findings":       node = renderFindings(a); break;
      case "diff":           node = renderDiff(a, optsWithIndex); break;
      case "files":          node = renderFiles(a, optsWithIndex); break;
      case "mentions":       node = renderMentions(a, opts); break;
      case "concepts":       node = renderConcepts(a); break;
      case "steps":          node = renderSteps(a); break;
      case "tree":           node = renderTree(a); break;
      case "json":           node = renderJson(a, { task: a.task || opts.task }); break;
      case "commitDraft":    node = renderCommitDraft(a, opts); break;
      case "deployDraft":    node = renderDeployDraft(a, opts); break;
      case "projectSummary": node = renderProjectSummary(a); break;
      case "mermaid":
      case "mindmap":
        node = el("div", { class: "ai-diagram", dataset: { diagram: "mermaid", source: a.source || "" } },
          el("pre", null, a.source || ""),
        );
        break;
      case "flowtable":
        node = el("div", { class: "ai-flowtable", dataset: { flowtable: JSON.stringify(a) } },
          el("pre", null, JSON.stringify(a, null, 2)),
        );
        break;
      default:
        node = el("div", { class: "ai-unknown" },
          el("div", { class: "ai-empty" }, `Unknown artifact: ${a.type}`),
          el("pre", null, JSON.stringify(a, null, 2)),
        );
    }
    if (node) {
      if (!node.dataset.artifactIndex) node.dataset.artifactIndex = String(index);
      root.appendChild(node);
    }
  });

  Promise.resolve().then(() => hydrateMarkdown(root)).catch(() => {});
}

// =========================================================================
// USAGE / QUOTA FORMATTING (used by ai-page.js HUD and footer)
// =========================================================================

export function formatCompact(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return "—";
  if (v >= 1_000_000) return (v / 1_000_000).toFixed(1) + "M";
  if (v >= 10_000) return Math.round(v / 1000) + "k";
  if (v >= 1_000) return (v / 1000).toFixed(1) + "k";
  return String(v);
}

export function formatRelativeReset(resetAt) {
  if (!resetAt) return "";
  const ms = new Date(resetAt).getTime() - Date.now();
  if (!Number.isFinite(ms)) return "";
  if (ms <= 0) return "now";
  const mins = Math.round(ms / 60000);
  if (mins < 60) return `in ${mins}m`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `in ${hours}h`;
  const days = Math.round(hours / 24);
  return `in ${days}d`;
}

// =========================================================================
// EXPORTS
// =========================================================================

export {
  API_BASE,
  API_AI,
  NOTES_PATH,
  NOTES_MAX_COUNT,
  NOTES_MAX_BODY_BYTES,
  AI_RUNS_MAX,
  AI_PENDING_TTL_MS,
  GUEST_TASKS,
  HOST_TASKS,
  APPLY_TASKS,
  TASK_META,
};