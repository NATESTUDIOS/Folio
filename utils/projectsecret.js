// utils/projectSecrets.js
// ═══════════════════════════════════════════════════════════════════
//  Folio Project Secrets — encrypted storage for per-project env vars
//  ────────────────────────────────────────────────────────────────
//  Path: secrets/{pid}/entries/{KEY}
//  Storage: AES-256-GCM (if FOLIO_SECRETS_KEY is set), plaintext fallback
//  Access: owner/editor only, unless visibility.secrets === "inject"
// ═══════════════════════════════════════════════════════════════════

import crypto from "node:crypto";
import { db } from "./firebase.js";
import { log } from "./log.js";

const MASTER_KEY_HEX = process.env.FOLIO_SECRETS_KEY || "";
const MASTER_KEY = MASTER_KEY_HEX ? Buffer.from(MASTER_KEY_HEX, "hex") : null;
const ENCRYPTION_ENABLED = !!MASTER_KEY && MASTER_KEY.length === 32;

const MAX_KEY_LENGTH = 128;
const MAX_VALUE_BYTES = 16 * 1024;   // 16 KB per value
const MAX_TOTAL_BYTES = 512 * 1024;  // 512 KB total per project
const KEY_PATTERN = /^[A-Z][A-Z0-9_]{0,127}$/;   // SCREAMING_SNAKE_CASE

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

// ── Public API ────────────────────────────────────────────────────

/**
 * Read all secrets for a project, decrypted.
 * Returns { entries: { KEY: { value, note, createdAt, updatedAt } }, meta: {...} }
 * Throws if any entry fails to decrypt (e.g. master key rotated incorrectly).
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
        createdAt: stored.createdAt || null,
        updatedAt: stored.updatedAt || null,
      };
    } catch (err) {
      log("secrets.decrypt_failed", { pid, key, message: err.message });
      entries[key] = {
        value: null,
        note: stored.note || null,
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
 * Read only the values, ready for injection. Throws on any decryption
 * failure so we don't inject partial secrets (safer to inject nothing
 * than a half-broken set).
 */
export async function readSecretsForInjection(pid) {
  const snap = await db.ref(`secrets/${pid}`).once("value");
  if (!snap.exists()) return {};
  const raw = snap.val() || {};
  const rawEntries = raw.entries || {};
  const out = {};
  for (const [key, stored] of Object.entries(rawEntries)) {
    const value = decrypt(stored, pid);
    if (value === null) {
      throw new Error(`Failed to decrypt secret: ${key}`);
    }
    out[key] = value;
  }
  return out;
}

/**
 * Set (create or update) a secret. Caller must have already checked
 * role permission — this function does no auth.
 */
export async function setSecret(pid, uid, key, value, note = null) {
  const keyErr = validateKey(key);
  if (keyErr) throw Object.assign(new Error(keyErr), { status: 400 });
  const valueErr = validateValue(value);
  if (valueErr) throw Object.assign(new Error(valueErr), { status: 400 });

  // Enforce total size limit
  const existing = await readSecrets(pid);
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
    createdAt: existing.entries[key]?.createdAt || now,
    updatedAt: now,
  };
  await db.ref(`secrets/${pid}/entries/${key}`).set(stored);
  await db.ref(`secrets/${pid}/lastUpdated`).set(now);
  await db.ref(`secrets/${pid}/lastUpdatedBy`).set(uid);
  return { key, updatedAt: now };
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
 * Get a summary of stored secret keys (no values) for display.
 */
export async function listSecretKeys(pid) {
  const snap = await db.ref(`secrets/${pid}/entries`).once("value");
  if (!snap.exists()) return { keys: [], count: 0 };
  const keys = [];
  snap.forEach((child) => {
    const v = child.val() || {};
    keys.push({
      key: child.key,
      note: v.note || null,
      createdAt: v.createdAt || null,
      updatedAt: v.updatedAt || null,
    });
  });
  keys.sort((a, b) => a.key.localeCompare(b.key));
  return { keys, count: keys.length };
}

export function isEncryptionEnabled() {
  return ENCRYPTION_ENABLED;
}