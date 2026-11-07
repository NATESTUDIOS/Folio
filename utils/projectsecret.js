// utils/projectsecret.js
// ═══════════════════════════════════════════════════════════════════
//  Folio Project Secrets — encrypted storage for per-project env vars
//  ────────────────────────────────────────────────────────────────
//  Path: secrets/{pid}/entries/{KEY}
//  Storage: AES-256-GCM (if FOLIO_SECRETS_KEY is set), plaintext fallback
//  Access: owner writes; editors see names only
//
//  Per-key visibility:
//    "private" (default) — appears only in ENV (server-side)
//    "public"            — appears in ENV AND window.__SECRETS__ (frontend)
//
//  Reserved names:
//    A fixed set of names is auto-injected at runtime by api/run.js
//    (PROJECT_ID, PROJECT_URL, FOLIO_BASE_URL, etc.). Users cannot
//    create secrets with these names — setSecret rejects them unless
//    called with { allowReserved: true } (used only for FOLIO_API_KEY).
// ═══════════════════════════════════════════════════════════════════

import crypto from "node:crypto";
import { db } from "./firebase.js";
import { log } from "./log.js";

const MASTER_KEY_HEX = process.env.FOLIO_SECRETS_KEY || "";
const MASTER_KEY = MASTER_KEY_HEX ? Buffer.from(MASTER_KEY_HEX, "hex") : null;
const ENCRYPTION_ENABLED = !!MASTER_KEY && MASTER_KEY.length === 32;

const MAX_KEY_LENGTH = 128;
const MAX_VALUE_BYTES = 16 * 1024;
const MAX_TOTAL_BYTES = 512 * 1024;
const MAX_COUNT = 50;
const KEY_PATTERN = /^[A-Z][A-Z0-9_]{0,127}$/;

const VALID_VISIBILITIES = new Set(["private", "public"]);

/**
 * Names that api/run.js auto-injects at runtime.
 * Users cannot create secrets with these names (except FOLIO_API_KEY,
 * which is written internally by handleApiKeyGenerate).
 */
export const RESERVED_ENV_NAMES = new Set([
  "PROJECT_ID",
  "PROJECT_NAME",
  "PROJECT_SLUG",
  "PROJECT_URL",
  "OWNER_USERNAME",
  "OWNER_UID",
  "DEPLOYMENT_ID",
  "DEPLOYMENT_URL",
  "FOLIO_BASE_URL",
  "FOLIO_API_URL",
  "API_ROUTE",
  "REQUEST_ID",
  "FOLIO_API_KEY",
]);

// ── Encryption ────────────────────────────────────────────────────

function deriveProjectKey(pid) {
  return crypto.createHmac("sha256", MASTER_KEY).update(String(pid)).digest();
}

function encrypt(plaintext, pid) {
  if (!ENCRYPTION_ENABLED) return { enc: false, value: plaintext };
  const key = deriveProjectKey(pid);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const enc = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    enc: true,
    iv: iv.toString("base64"),
    tag: tag.toString("base64"),
    data: enc.toString("base64"),
  };
}

function decrypt(stored, pid) {
  if (!stored || typeof stored !== "object") return null;
  if (!stored.enc) return stored.value;
  if (!ENCRYPTION_ENABLED) {
    throw new Error("Encrypted secret found but FOLIO_SECRETS_KEY is not set");
  }
  const key = deriveProjectKey(pid);
  const iv = Buffer.from(stored.iv, "base64");
  const tag = Buffer.from(stored.tag, "base64");
  const data = Buffer.from(stored.data, "base64");
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8");
}

// ── Validation ────────────────────────────────────────────────────

function validateKey(key) {
  if (typeof key !== "string") return "Key must be a string";
  if (key.length > MAX_KEY_LENGTH) return "Key is too long";
  if (!KEY_PATTERN.test(key)) {
    return "Key must be UPPER_SNAKE_CASE (A-Z, 0-9, _) and start with a letter";
  }
  return null;
}

function validateValue(value) {
  if (typeof value !== "string") return "Value must be a string";
  if (Buffer.byteLength(value, "utf8") > MAX_VALUE_BYTES) {
    return `Value exceeds ${MAX_VALUE_BYTES / 1024} KB`;
  }
  return null;
}

function normalizeVisibility(v) {
  if (v === undefined || v === null) return "private";
  const s = String(v).toLowerCase();
  if (!VALID_VISIBILITIES.has(s)) return null;
  return s;
}

// ── Public API ────────────────────────────────────────────────────

/**
 * Read all secrets for a project, decrypted, with metadata.
 * Returns { entries: { KEY: { value, note, visibility, createdAt, updatedAt } }, meta }
 * Throws if any entry fails to decrypt.
 */
export async function readSecrets(pid) {
  const snap = await db.ref(`secrets/${pid}`).once("value");
  if (!snap.exists()) {
    return { entries: {}, meta: { updatedAt: null, updatedBy: null, count: 0 } };
  }
  const raw = snap.val() || {};
  const entries = {};
  const rawEntries = raw.entries || {};
  for (const [key, stored] of Object.entries(rawEntries)) {
    try {
      entries[key] = {
        value: decrypt(stored, pid),
        note: stored.note || null,
        visibility: stored.visibility || "private",
        createdAt: stored.createdAt || null,
        updatedAt: stored.updatedAt || null,
      };
    } catch (err) {
      log("secrets.decrypt_failed", { pid, key, message: err.message });
      entries[key] = {
        value: null,
        note: stored.note || null,
        visibility: stored.visibility || "private",
        createdAt: stored.createdAt || null,
        updatedAt: stored.updatedAt || null,
        error: "decrypt_failed",
      };
    }
  }
  return {
    entries,
    meta: {
      updatedAt: raw.lastUpdated || null,
      updatedBy: raw.lastUpdatedBy || null,
      count: Object.keys(entries).length,
    },
  };
}

/**
 * Read all secrets for the runtime sandbox (ENV object).
 * Returns a flat object { KEY: value } with all secrets (public + private).
 * Throws if any entry fails to decrypt — never injects a partial set.
 */
export async function readAllSecrets(pid) {
  const { entries } = await readSecrets(pid);
  const env = {};
  for (const [key, entry] of Object.entries(entries)) {
    if (entry.error) {
      throw new Error(`Failed to decrypt secret: ${key}`);
    }
    env[key] = entry.value;
  }
  return env;
}

/**
 * Read only secrets marked "public", decrypted.
 * Used by handleServe to inject window.__SECRETS__ into HTML.
 */
export async function readPublicSecrets(pid) {
  const { entries } = await readSecrets(pid);
  const pub = {};
  for (const [key, entry] of Object.entries(entries)) {
    if (entry.visibility === "public" && !entry.error) {
      pub[key] = entry.value;
    }
  }
  return pub;
}

/**
 * Read only secrets marked "public", without decrypting.
 * Used for the dashboard's "public keys" summary.
 */
export async function listPublicKeys(pid) {
  const snap = await db.ref(`secrets/${pid}/entries`).once("value");
  if (!snap.exists()) return [];
  const keys = [];
  snap.forEach((child) => {
    const v = child.val() || {};
    if (v.visibility === "public") {
      keys.push({ key: child.key, note: v.note || null, updatedAt: v.updatedAt || null });
    }
  });
  return keys;
}

/**
 * Set (create or update) a secret.
 * Caller must have already checked role permission.
 *
 * @param {string} pid
 * @param {string} uid
 * @param {string} key
 * @param {string} value
 * @param {string|null} note
 * @param {string} visibility  "private" (default) or "public"
 * @param {object} opts        { allowReserved: boolean } — bypass reserved-name check
 */
export async function setSecret(
  pid,
  uid,
  key,
  value,
  note = null,
  visibility = "private",
  opts = {},
) {
  const keyErr = validateKey(key);
  if (keyErr) throw Object.assign(new Error(keyErr), { status: 400 });
  const valueErr = validateValue(value);
  if (valueErr) throw Object.assign(new Error(valueErr), { status: 400 });

  // Reserved-name check (bypassed only for internal writes, e.g. FOLIO_API_KEY)
  if (!opts.allowReserved && RESERVED_ENV_NAMES.has(key)) {
    throw Object.assign(
      new Error(
        `"${key}" is a reserved name — it is auto-injected at runtime and cannot be overridden.`,
      ),
      { status: 400 },
    );
  }

  const vis = normalizeVisibility(visibility);
  if (!vis) {
    throw Object.assign(
      new Error('visibility must be "private" or "public"'),
      { status: 400 },
    );
  }

  const existing = await readSecrets(pid);

  // Count limit (only for new keys)
  if (!(key in existing.entries) && Object.keys(existing.entries).length >= MAX_COUNT) {
    throw Object.assign(
      new Error(`Maximum ${MAX_COUNT} secrets per project`),
      { status: 400 },
    );
  }

  // Total size limit (excluding the key being replaced)
  let totalBytes = Buffer.byteLength(value, "utf8");
  for (const [k, e] of Object.entries(existing.entries)) {
    if (k === key) continue;
    if (e.value) totalBytes += Buffer.byteLength(e.value, "utf8");
  }
  if (totalBytes > MAX_TOTAL_BYTES) {
    throw Object.assign(
      new Error(`Total secrets size exceeds ${MAX_TOTAL_BYTES / 1024} KB`),
      { status: 413 },
    );
  }

  const now = Date.now();
  const encrypted = encrypt(value, pid);
  const stored = {
    ...encrypted,
    note: note ? String(note).slice(0, 200) : null,
    visibility: vis,
    createdAt: existing.entries[key]?.createdAt || now,
    updatedAt: now,
  };

  await db.ref(`secrets/${pid}/entries/${key}`).set(stored);
  await db.ref(`secrets/${pid}/lastUpdated`).set(now);
  await db.ref(`secrets/${pid}/lastUpdatedBy`).set(uid);

  return { key, visibility: vis, updatedAt: now };
}

/**
 * Update a secret's visibility without re-entering the value.
 */
export async function updateSecretVisibility(pid, uid, key, visibility) {
  const vis = normalizeVisibility(visibility);
  if (!vis) {
    throw Object.assign(
      new Error('visibility must be "private" or "public"'),
      { status: 400 },
    );
  }

  const ref = db.ref(`secrets/${pid}/entries/${key}`);
  const snap = await ref.once("value");
  if (!snap.exists()) {
    throw Object.assign(new Error("Secret not found"), { status: 404 });
  }

  const current = snap.val() || {};
  if (current.visibility === vis) {
    return { key, visibility: vis, updatedAt: current.updatedAt || null, changed: false };
  }

  const now = Date.now();
  await ref.update({ visibility: vis, updatedAt: now });
  await db.ref(`secrets/${pid}/lastUpdated`).set(now);
  await db.ref(`secrets/${pid}/lastUpdatedBy`).set(uid);

  return { key, visibility: vis, updatedAt: now, changed: true };
}

/**
 * Delete a secret.
 */
export async function deleteSecret(pid, uid, key) {
  const ref = db.ref(`secrets/${pid}/entries/${key}`);
  const snap = await ref.once("value");
  if (!snap.exists()) {
    throw Object.assign(new Error("Secret not found"), { status: 404 });
  }
  await ref.remove();
  await db.ref(`secrets/${pid}/lastUpdated`).set(Date.now());
  await db.ref(`secrets/${pid}/lastUpdatedBy`).set(uid);
  return { key, deleted: true };
}

/**
 * Delete all secrets for a project. Called when a project is deleted.
 */
export async function deleteAllSecrets(pid) {
  await db.ref(`secrets/${pid}`).remove();
}

/**
 * Get metadata for all stored secrets (no values).
 */
export async function listSecretKeys(pid) {
  const snap = await db.ref(`secrets/${pid}/entries`).once("value");
  if (!snap.exists()) return { keys: [], count: 0, publicCount: 0 };

  const keys = [];
  let publicCount = 0;
  snap.forEach((child) => {
    const v = child.val() || {};
    const vis = v.visibility || "private";
    if (vis === "public") publicCount++;
    keys.push({
      key: child.key,
      note: v.note || null,
      visibility: vis,
      createdAt: v.createdAt || null,
      updatedAt: v.updatedAt || null,
    });
  });
  keys.sort((a, b) => a.key.localeCompare(b.key));
  return { keys, count: keys.length, publicCount };
}

export function isEncryptionEnabled() {
  return ENCRYPTION_ENABLED;
}

export function getReservedEnvNames() {
  return [...RESERVED_ENV_NAMES];
}