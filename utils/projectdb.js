// utils/projectDb.js
// ═══════════════════════════════════════════════════════════════════
//  Folio ProjectDB — storage layer for projectData/{pid}
//  ────────────────────────────────────────────────────────────────
//  Pure storage functions. No HTTP, no rate limiting, no auth.
//  Callers (api/host.js, future APIs) handle those concerns.
//
//  Public API:
//    dbRead(pid)                                    → data
//    dbWritePath(pid, key, value)                   → { finalSize, space }
//    dbMerge(pid, data)                             → { finalSize, space }
//    dbReplace(pid, data)                           → { finalSize, space }
//    dbBatch(pid, updates)                          → { pathsWritten, bytes }
//    dbCas(pid, key, expected, value)               → { applied, current }
//    dbIncrement(pid, key, by)                      → { value }
//    dbList(pid, path, opts)                        → { items, count }
//    dbBackup(pid, uid)                             → { at, bytes }
//    dbSnapshotList(pid)                            → { snapshots }
//    dbSnapshotRestore(pid, ts)                     → { restoredBytes }
//    dbSchemaGet(pid)                               → schema | null
//    dbSchemaSet(pid, schema)                       → void
//    dbCacheInvalidate(pid)                         → void
//    setStorageWarningHandler(fn)                   → void
// ═══════════════════════════════════════════════════════════════════

import { db } from "./firebase.js";
import { log } from "./log.js";
import { sanitizeFirebasePath } from "./users.js";

// =========================================================================
// CONFIG
// =========================================================================

const DB_CACHE_TTL = 1000;              // 1s — cross-instance staleness is negligible
const DB_CACHE_MAX = 500;
const DB_CACHE_INFLIGHT_MAX = 500;

const DB_LIMIT = 15 * 1024 * 1024;               // 15 MB total
const DB_MAX_SINGLE_WRITE_BYTES = 2 * 1024 * 1024; // 2 MB per write
const DB_MAX_BATCH_BYTES = 2 * 1024 * 1024;      // 2 MB per batch
const DB_MAX_BATCH_ENTRIES = 100;
const DB_BACKUP_LIMIT = 5 * 1024 * 1024;         // 5 MB per backup
const DB_MAX_BACKUPS = 10;
const DB_MAX_SNAPSHOTS = 3;

// =========================================================================
// CACHE
// =========================================================================

const DB_CACHE = new Map();           // pid -> { data, at }
const DB_CACHE_INFLIGHT = new Map(); // pid -> Promise (dedup concurrent reads)

function dbCacheGet(pid) {
  const entry = DB_CACHE.get(pid);
  if (!entry) return null;
  if (Date.now() - entry.at > DB_CACHE_TTL) {
    DB_CACHE.delete(pid);
    return null;
  }
  return entry.data;
}

function dbCacheSet(pid, data) {
  if (DB_CACHE.size >= DB_CACHE_MAX) {
    const first = DB_CACHE.keys().next().value;
    if (first) DB_CACHE.delete(first);
  }
  DB_CACHE.set(pid, { data, at: Date.now() });
}

export function dbCacheInvalidate(pid) {
  DB_CACHE.delete(pid);
  DB_CACHE_INFLIGHT.delete(pid);
}

function dbCacheApplyWrites(pid, flatWrites) {
  const current = DB_CACHE.get(pid);
  if (!current) return;

  const next = JSON.parse(JSON.stringify(current.data));
  for (const [path, value] of Object.entries(flatWrites)) {
    const parts = path.split("/").filter(Boolean);
    let node = next;
    for (let i = 0; i < parts.length - 1; i++) {
      if (!node[parts[i]] || typeof node[parts[i]] !== "object") node[parts[i]] = {};
      node = node[parts[i]];
    }
    if (value === null || value === undefined) {
      delete node[parts[parts.length - 1]];
    } else {
      node[parts[parts.length - 1]] = value;
    }
  }
  DB_CACHE.set(pid, { data: next, at: Date.now() });
}

async function readProjectDataCached(pid) {
  // Inflight dedup only — no read cache. Guarantees freshness across
  // serverless instances (Vercel runs multiple function instances, and
  // per-instance caches go stale).
  const inflight = DB_CACHE_INFLIGHT.get(pid);
  if (inflight) return inflight;

  const promise = (async () => {
    const snap = await db.ref(`projectData/${pid}`).once("value");
    const data = snap.exists() ? snap.val() : {};
    dbCacheSet(pid, data);
    return data;
  })();

  DB_CACHE_INFLIGHT.set(pid, promise);
  try {
    return await promise;
  } finally {
    DB_CACHE_INFLIGHT.delete(pid);
  }
}

// =========================================================================
// STORAGE WARNING HOOK
// =========================================================================

let _storageWarningHandler = null;

export function setStorageWarningHandler(fn) {
  _storageWarningHandler = fn;
}

async function maybeWarnStorage(pid, size) {
  if (!_storageWarningHandler) return;
  if (size < DB_LIMIT * 0.8) return;
  try {
    await _storageWarningHandler(pid, size, DB_LIMIT);
  } catch (err) {
    log("projectDb.storage_warning_failed", { pid, message: err.message });
  }
}

// =========================================================================
// VALIDATION
// =========================================================================

function validateSegments(rawParts) {
  const safeParts = [];
  for (const raw of rawParts) {
    const s = String(raw);
    const safe = sanitizeFirebasePath(s);
    if (!safe) {
      const err = new Error(`Invalid path segment: "${s}"`);
      err.status = 400;
      throw err;
    }
    if (safe !== s) {
      const err = new Error(
        `Key segment "${s}" contains reserved characters (. # $ [ ]) and would be altered. ` +
        `Use a different key or encode them.`
      );
      err.status = 400;
      throw err;
    }
    safeParts.push(safe);
  }
  return safeParts;
}

// =========================================================================
// SIZE
// =========================================================================

async function computeDbSize(pid) {
  try {
    const snap = await db.ref(`projectData/${pid}`).once("value");
    return JSON.stringify(snap.val() || {}).length;
  } catch {
    return 0;
  }
}

function buildSpace(fullSize) {
  const spaceRemaining = Math.max(0, DB_LIMIT - fullSize);
  const percentUsed =
    DB_LIMIT > 0
      ? Math.min(100, Math.round((fullSize / DB_LIMIT) * 1000) / 10)
      : 0;
  return { used: fullSize, remaining: spaceRemaining, limit: DB_LIMIT, percentUsed };
}

// =========================================================================
// PUBLIC API
// =========================================================================

export async function dbRead(pid) {
  return await readProjectDataCached(pid);
}

export async function dbWritePath(pid, key, value) {
  const parts = String(key).split("/").filter(Boolean);
  if (parts.length === 0) {
    const err = new Error("Invalid key path");
    err.status = 400;
    throw err;
  }

  if (parts.length === 1 && value === undefined) {
    const err = new Error(
      "Refusing to delete a top-level subtree. " +
      "Write null at a deeper key path to delete a specific child."
    );
    err.status = 400;
    throw err;
  }

  const safeParts = validateSegments(parts);

  let nested = value === undefined ? null : value;
  for (let i = safeParts.length - 1; i >= 0; i--) {
    nested = { [safeParts[i]]: nested };
  }

  const serialized = JSON.stringify(value === undefined ? null : value);
  if (serialized.length > DB_MAX_SINGLE_WRITE_BYTES) {
    const err = new Error(
      `Single write exceeds ${DB_MAX_SINGLE_WRITE_BYTES / 1024 / 1024} MB`
    );
    err.status = 413;
    throw err;
  }

  await db.ref(`projectData/${pid}`).update(nested);
  dbCacheApplyWrites(pid, { [safeParts.join("/")]: value === undefined ? null : value });

  const finalSize = await computeDbSize(pid);
  const space = buildSpace(finalSize);
  await maybeWarnStorage(pid, finalSize);

  return { finalSize, space, bytes: serialized.length, path: safeParts.join("/") };
}

export async function dbMerge(pid, data) {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    const err = new Error("Merge data must be a plain object");
    err.status = 400;
    throw err;
  }
  if (Object.keys(data).length === 0) {
    const err = new Error("Nothing to merge");
    err.status = 400;
    throw err;
  }
  const serialized = JSON.stringify(data);
  if (serialized.length > DB_MAX_SINGLE_WRITE_BYTES) {
    const err = new Error(
      `Merge exceeds ${DB_MAX_SINGLE_WRITE_BYTES / 1024 / 1024} MB`
    );
    err.status = 413;
    throw err;
  }

  await db.ref(`projectData/${pid}`).update(data);
  dbCacheInvalidate(pid);

  const finalSize = await computeDbSize(pid);
  const space = buildSpace(finalSize);
  await maybeWarnStorage(pid, finalSize);

  return { finalSize, space, bytes: serialized.length, keys: Object.keys(data) };
}

export async function dbReplace(pid, data, { reqId = null } = {}) {
  // Snapshot current state before overwriting
  try {
    const current = await db.ref(`projectData/${pid}`).once("value");
    if (current.exists()) {
      const ts = Date.now();
      await db.ref(`projectDataSnapshots/${pid}/${ts}`).set(current.val());
      await pruneSnapshots(pid);
    }
  } catch (err) {
    log("projectDb.snapshot_failed", { pid, reqId, message: err.message });
  }

  const serialized = JSON.stringify(data ?? null);
  if (serialized.length > DB_LIMIT) {
    const err = new Error("Payload too large (15 MB max)");
    err.status = 413;
    throw err;
  }

  await db.ref(`projectData/${pid}`).set(data);
  dbCacheInvalidate(pid);

  const finalSize = await computeDbSize(pid);
  const space = buildSpace(finalSize);
  await maybeWarnStorage(pid, finalSize);

  return { finalSize, space, bytes: serialized.length };
}

export async function dbBatch(pid, updates) {
  if (!Array.isArray(updates) || updates.length === 0) {
    const err = new Error("Missing updates array");
    err.status = 400;
    throw err;
  }
  if (updates.length > DB_MAX_BATCH_ENTRIES) {
    const err = new Error(
      `Too many paths in one batch (max ${DB_MAX_BATCH_ENTRIES})`
    );
    err.status = 400;
    throw err;
  }

  const flat = {};
  let totalBytes = 0;

  for (const entry of updates) {
    if (!entry || typeof entry !== "object") {
      const err = new Error("Each update must be { key, value }");
      err.status = 400;
      throw err;
    }
    const { key, value } = entry;
    if (typeof key !== "string" || !key) {
      const err = new Error("Each update needs a key");
      err.status = 400;
      throw err;
    }
    const parts = key.split("/").filter(Boolean);
    if (parts.length === 0) {
      const err = new Error(`Invalid key: "${key}"`);
      err.status = 400;
      throw err;
    }
    const safeParts = validateSegments(parts);
    const path = safeParts.join("/");
    if (path in flat) {
      const err = new Error(`Duplicate key in batch: "${key}"`);
      err.status = 400;
      throw err;
    }
    flat[path] = value === undefined ? null : value;
    totalBytes += JSON.stringify(flat[path])?.length || 0;
  }

  if (totalBytes > DB_MAX_BATCH_BYTES) {
    const err = new Error(
      `Batch exceeds ${DB_MAX_BATCH_BYTES / 1024 / 1024} MB`
    );
    err.status = 413;
    throw err;
  }

  await db.ref(`projectData/${pid}`).update(flat);
  dbCacheApplyWrites(pid, flat);

  const finalSize = await computeDbSize(pid);
  await maybeWarnStorage(pid, finalSize);

  return {
    pathsWritten: Object.keys(flat).length,
    bytes: totalBytes,
    space: buildSpace(finalSize),
  };
}

export async function dbCas(pid, key, expected, value) {
  if (typeof key !== "string" || key === "") {
    const err = new Error("Missing key");
    err.status = 400;
    throw err;
  }
  const parts = key.split("/").filter(Boolean);
  if (parts.length === 0) {
    const err = new Error("Invalid key");
    err.status = 400;
    throw err;
  }
  const safeParts = validateSegments(parts);
  const path = safeParts.join("/");
  const ref = db.ref(`projectData/${pid}/${path}`);

  let applied = false;
  let currentValue = null;

  await ref.transaction((current) => {
    currentValue = current;
    const matches = expected === null
      ? current === null || current === undefined
      : JSON.stringify(current) === JSON.stringify(expected);
    if (matches) {
      applied = true;
      return value === undefined ? null : value;
    }
    return undefined;
  });

  dbCacheInvalidate(pid);
  return { applied, current: currentValue ?? null, path };
}

export async function dbIncrement(pid, key, by = 1) {
  if (typeof key !== "string" || !key) {
    const err = new Error("Missing key");
    err.status = 400;
    throw err;
  }
  if (typeof by !== "number" || !Number.isFinite(by)) {
    const err = new Error("by must be a number");
    err.status = 400;
    throw err;
  }
  const parts = key.split("/").filter(Boolean);
  if (parts.length === 0) {
    const err = new Error("Invalid key");
    err.status = 400;
    throw err;
  }
  const safeParts = validateSegments(parts);
  const path = safeParts.join("/");
  const ref = db.ref(`projectData/${pid}/${path}`);

  let newValue = null;
  await ref.transaction((current) => {
    const base = typeof current === "number" ? current : 0;
    newValue = base + by;
    return newValue;
  });

  dbCacheInvalidate(pid);
  return { path, value: newValue };
}

export async function dbList(pid, path, opts = {}) {
  const {
    orderBy = null,
    limit = 50,
    startAt = null,
    endAt = null,
  } = opts;

  const clampLimit = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 500);
  const safePath = path
    ? validateSegments(path.split("/").filter(Boolean)).join("/")
    : "";

  let ref = db.ref(`projectData/${pid}` + (safePath ? `/${safePath}` : ""));
  if (orderBy) ref = ref.orderByChild(orderBy);
  if (startAt != null) ref = ref.startAt(startAt);
  if (endAt != null) ref = ref.endAt(endAt);

  const snap = await ref.limitToFirst(clampLimit).once("value");
  const items = [];
  if (snap.exists()) {
    snap.forEach((c) => items.push({ key: c.key, value: c.val() }));
  }

  return {
    path: safePath || "/",
    items,
    count: items.length,
    limit: clampLimit,
    orderBy: orderBy || null,
  };
}

export async function dbBackup(pid, uid) {
  const snap = await db.ref(`projectData/${pid}`).once("value");
  if (!snap.exists()) {
    return { at: null, bytes: 0, message: "Empty DB" };
  }

  const data = snap.val();
  const serialized = JSON.stringify(data);
  const ts = Date.now();
  const size = serialized.length;

  if (size > DB_BACKUP_LIMIT) {
    const err = new Error(
      `DB too large to back up (>${DB_BACKUP_LIMIT / 1024 / 1024} MB)`
    );
    err.status = 413;
    throw err;
  }

  await db.ref(`projectBackups/${pid}/${ts}`).set({
    at: ts,
    bytes: size,
    by: uid,
    data,
  });

  await pruneBackups(pid);
  return { at: ts, bytes: size };
}

export async function dbSnapshotList(pid) {
  const snap = await db.ref(`projectDataSnapshots/${pid}`).once("value");
  const snapshots = [];
  if (snap.exists()) {
    snap.forEach((c) => {
      snapshots.push({
        ts: Number(c.key),
        bytes: JSON.stringify(c.val()).length,
      });
    });
  }
  snapshots.sort((a, b) => b.ts - a.ts);
  return { pid, snapshots };
}

export async function dbSnapshotRestore(pid, ts) {
  if (!pid || !ts) {
    const err = new Error("Missing pid or ts");
    err.status = 400;
    throw err;
  }

  const snap = await db.ref(`projectDataSnapshots/${pid}/${ts}`).once("value");
  if (!snap.exists()) {
    const err = new Error("Snapshot not found");
    err.status = 404;
    throw err;
  }

  await db.ref(`projectData/${pid}`).set(snap.val());
  dbCacheInvalidate(pid);
  return { pid, ts, restoredBytes: JSON.stringify(snap.val()).length };
}

export async function dbSchemaGet(pid) {
  const snap = await db.ref(`projectSchemas/${pid}`).once("value");
  return snap.exists() ? snap.val() : null;
}

export async function dbSchemaSet(pid, schema) {
  const fields = Array.isArray(schema?.fields) ? schema.fields : [];
  if (fields.length > 100) {
    const err = new Error("Too many schema fields (max 100)");
    err.status = 400;
    throw err;
  }
  await db.ref(`projectSchemas/${pid}`).set({
    fields,
    layout: schema?.layout || null,
    updatedAt: Date.now(),
  });
}

// =========================================================================
// INTERNAL PRUNING
// =========================================================================

async function pruneSnapshots(pid) {
  const snapSnap = await db.ref(`projectDataSnapshots/${pid}`).once("value");
  if (!snapSnap.exists()) return;

  const keys = [];
  snapSnap.forEach((c) => keys.push({ key: c.key, ts: Number(c.key) || 0 }));
  keys.sort((a, b) => b.ts - a.ts);

  for (const k of keys.slice(DB_MAX_SNAPSHOTS)) {
    await db.ref(`projectDataSnapshots/${pid}/${k.key}`).remove();
  }
}

async function pruneBackups(pid) {
  const bSnap = await db.ref(`projectBackups/${pid}`).once("value");
  if (!bSnap.exists()) return;

  const keys = [];
  bSnap.forEach((c) => keys.push({ key: c.key, ts: Number(c.key) || 0 }));
  keys.sort((a, b) => b.ts - a.ts);

  for (const k of keys.slice(DB_MAX_BACKUPS)) {
    await db.ref(`projectBackups/${pid}/${k.key}`).remove();
  }
}