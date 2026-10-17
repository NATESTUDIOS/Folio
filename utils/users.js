// utils/users.js
import crypto from "crypto";
import jwt from "jsonwebtoken";
import { db } from "./firebase.js";

// =========================================================================
// JWT
// =========================================================================

const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET || JWT_SECRET.length < 32) {
  throw new Error("JWT_SECRET must be set to a 32+ character secret");
}

export function signSession(uid, username) {
  return jwt.sign({ uid, username }, JWT_SECRET, { expiresIn: "30d" });
}

export function verifySession(token) {
  if (!token || typeof token !== "string") return null;
  try {
    return jwt.verify(token, JWT_SECRET);
  } catch {
    return null;
  }
}

// =========================================================================
// Password hashing (scrypt)
// =========================================================================

const SCRYPT_N = 16384;
const SCRYPT_r = 8;
const SCRYPT_p = 1;
const KEYLEN = 64;

export function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, KEYLEN, {
    N: SCRYPT_N, r: SCRYPT_r, p: SCRYPT_p,
  });
  return `scrypt$${SCRYPT_N}$${SCRYPT_r}$${SCRYPT_p}$${salt.toString("hex")}$${hash.toString("hex")}`;
}

export function verifyPassword(password, encoded) {
  try {
    if (typeof encoded !== "string") return false;
    const parts = encoded.split("$");
    if (parts.length !== 6 || parts[0] !== "scrypt") return false;
    const [, N, r, p, saltHex, hashHex] = parts;
    const salt = Buffer.from(saltHex, "hex");
    const expected = Buffer.from(hashHex, "hex");
    const actual = crypto.scryptSync(password, salt, expected.length, {
      N: Number(N), r: Number(r), p: Number(p),
    });
    return crypto.timingSafeEqual(expected, actual);
  } catch {
    return false;
  }
}

export function validatePassword(password) {
  if (typeof password !== "string") return "Password must be a string";
  if (password.length < 8) return "Password must be at least 8 characters";
  if (password.length > 128) return "Password must be at most 128 characters";
  if (!/\p{L}/u.test(password)) return "Password must contain a letter";
  if (!/\p{N}/u.test(password)) return "Password must contain a number";
  return null;
}

export function dummyHash() {
  const salt = crypto.randomBytes(16);
  crypto.scryptSync("dummy-password", salt, KEYLEN, {
    N: SCRYPT_N, r: SCRYPT_r, p: SCRYPT_p,
  });
}

// =========================================================================
// Auth middleware
// =========================================================================

export async function requireAuth(req, res) {
  const header = req.headers.authorization || "";
  if (!header.startsWith("Bearer ")) {
    res.status(401).json({ success: false, error: "Authentication required" });
    return null;
  }
  const decoded = verifySession(header.slice(7).trim());
  if (!decoded) {
    res.status(401).json({ success: false, error: "Invalid or expired session" });
    return null;
  }
  const user = await getUser(decoded.uid);
  if (!user) {
    res.status(401).json({ success: false, error: "Invalid or expired session" });
    return null;
  }
  if (user.mode === "banned") {
    res.status(403).json({ success: false, error: "Account suspended" });
    return null;
  }
  return { uid: decoded.uid, ...user, session: decoded };
}

export function requireAdmin(req, res) {
  const key = req.headers["x-api-key"] || req.headers["admin-api-key"] || "";
  const expected = process.env.ADMIN_API_KEY || "";
  if (!expected || key.length !== expected.length) {
    res.status(401).json({ success: false, error: "Unauthorized" });
    return false;
  }
  const ok = crypto.timingSafeEqual(Buffer.from(key), Buffer.from(expected));
  if (!ok) {
    res.status(403).json({ success: false, error: "Forbidden" });
    return false;
  }
  return true;
}

// =========================================================================
// User lookup
// =========================================================================

export async function getUser(uid) {
  if (!uid) return null;
  const snap = await db.ref(`users/${uid}`).once("value");
  if (!snap.exists()) return null;
  return { uid, ...snap.val() };
}

export async function getUserByEmail(emailLower) {
  if (!emailLower) return null;
  const cleaned = cleanEmail(emailLower);
  if (!cleaned) return null;
  const snap = await db.ref(`emails/${cleaned}`).once("value");
  if (!snap.exists()) return null;
  return getUser(snap.val());
}

export async function getUserByUsername(username) {
  const cleaned = cleanUsername(username);
  if (!cleaned) return null;
  const snap = await db.ref(`usernames/${cleaned}`).once("value");
  if (!snap.exists()) return null;
  return getUser(snap.val());
}

export async function isBanned(uid) {
  const snap = await db.ref(`users/${uid}/mode`).once("value");
  return snap.exists() && snap.val() === "banned";
}

// =========================================================================
// Username + email normalization
// =========================================================================

const RESERVED = new Set([
  "api", "user", "users", "assets", "_next", "static",
  "login", "signup", "settings", "p", "admin", "help", "docs",
  "dashboard", "app", "invite", "profile", "offline",
  "notify", "analytics", "host", "flier", "metatag",
  "register", "logout", "me", "refresh", "db", "logs",
  "www", "mail", "vercel", "folio",
]);

export function isReservedUsername(username) {
  return RESERVED.has(String(username || "").toLowerCase());
}

export function cleanUsername(username) {
  if (!username || typeof username !== "string") return null;
  const s = username.trim().toLowerCase();
  if (!/^[a-z0-9_-]{3,30}$/.test(s)) return null;
  return s;
}

export function cleanEmail(email) {
  if (!email || typeof email !== "string") return null;
  const s = email.trim().toLowerCase();
  if (s.length > 254) return null;
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s)) return null;
  return s;
}

// =========================================================================
// Username auto-suffix + reservations
// =========================================================================

export async function assignUsername(baseUsername, uid) {
  const cleaned = cleanUsername(baseUsername);
  if (!cleaned || isReservedUsername(cleaned)) return null;

  const maxBaseLen = 26;
  const base = cleaned.length > maxBaseLen ? cleaned.slice(0, maxBaseLen) : cleaned;

  for (let i = 0; i <= 9999; i++) {
    const candidate = i === 0 ? base : `${base}${i}`;
    if (isReservedUsername(candidate)) continue;
    const result = await db.ref(`usernames/${candidate}`).transaction(cur => {
      if (cur !== null) return;
      return uid;
    });
    if (result.committed) {
      return { username: candidate, isModified: candidate !== cleaned };
    }
  }

  for (let attempt = 0; attempt < 10; attempt++) {
    const suffix = crypto.randomBytes(3).toString("hex");
    const candidate = `${base}_${suffix}`;
    const result = await db.ref(`usernames/${candidate}`).transaction(cur => {
      if (cur !== null) return;
      return uid;
    });
    if (result.committed) {
      return { username: candidate, isModified: true };
    }
  }

  return null;
}

export async function reserveEmail(emailLower, uid) {
  const cleaned = cleanEmail(emailLower);
  if (!cleaned) return false;
  const result = await db.ref(`emails/${cleaned}`).transaction(cur => {
    if (cur !== null) return;
    return uid;
  });
  return result.committed;
}

export async function reserveUsername(username, uid) {
  const cleaned = cleanUsername(username);
  if (!cleaned) return false;
  const result = await db.ref(`usernames/${cleaned}`).transaction(cur => {
    if (cur !== null) return;
    return uid;
  });
  return result.committed;
}

export async function releaseEmail(emailLower) {
  const cleaned = cleanEmail(emailLower);
  if (!cleaned) return;
  await db.ref(`emails/${cleaned}`).remove();
}

export async function releaseUsername(username) {
  const cleaned = cleanUsername(username);
  if (!cleaned) return;
  await db.ref(`usernames/${cleaned}`).remove();
}

// =========================================================================
// Project permissions
// =========================================================================

export async function canAccessProject(uid, pid) {
  if (!uid || !pid) return null;
  const snap = await db.ref(`projects/${pid}`).once("value");
  if (!snap.exists()) return null;
  const p = snap.val();
  if (p.ownerId === uid) return "owner";
  const role = p.roles && p.roles[uid];
  return role || null;
}

export async function hasVisibility(pid, axis) {
  if (!pid || !axis) return false;
  const snap = await db.ref(`projects/${pid}/visibility/${axis}`).once("value");
  return snap.exists() && snap.val() === "public";
}

const ROLE_RANK = { viewer: 1, commenter: 2, editor: 3, owner: 4 };

export async function requireProjectRole(req, res, pid, minRole) {
  const user = await requireAuth(req, res);
  if (!user) return null;
  if (!pid) {
    res.status(400).json({ success: false, error: "Missing project id" });
    return null;
  }
  const role = await canAccessProject(user.uid, pid);
  if (!role) {
    res.status(404).json({ success: false, error: "Project not found" });
    return null;
  }
  const needed = ROLE_RANK[minRole] || 0;
  const have = ROLE_RANK[role] || 0;
  if (have < needed) {
    res.status(403).json({ success: false, error: "Insufficient permissions", required: minRole });
    return null;
  }
  return { uid: user.uid, role, user };
}

export async function canEditProject(uid, pid) {
  const role = await canAccessProject(uid, pid);
  return role === "owner" || role === "editor";
}

// =========================================================================
// Project API keys
// =========================================================================

export function generateApiKey() {
  const key = "fol_" + crypto.randomBytes(24).toString("hex");
  return { key, hash: hashApiKey(key) };
}

export function hashApiKey(key) {
  return crypto.createHash("sha256").update(String(key)).digest("hex");
}

export async function verifyProjectKey(pid, candidate) {
  if (!pid || !candidate) return false;
  const snap = await db.ref(`projects/${pid}/apiKeyHash`).once("value");
  if (!snap.exists()) return false;
  const stored = snap.val();
  const candidateHash = hashApiKey(candidate);
  if (stored.length !== candidateHash.length) return false;
  return crypto.timingSafeEqual(
    Buffer.from(stored, "hex"),
    Buffer.from(candidateHash, "hex"),
  );
}

// =========================================================================
// Invite tokens
// =========================================================================

export function generateInviteToken() {
  return "inv_" + crypto.randomBytes(16).toString("hex");
}

// =========================================================================
// Request + path helpers
// =========================================================================

export function getClientIp(req) {
  const xff = req.headers["x-forwarded-for"];
  if (typeof xff === "string" && xff.length) {
    const first = xff.split(",")[0].trim();
    if (first) return first;
  }
  const real = req.headers["x-real-ip"];
  if (typeof real === "string" && real.length) return real.trim();
  return req.socket?.remoteAddress || "unknown";
}

export function hashIp(ip) {
  return crypto.createHash("sha256").update(String(ip)).digest("hex").slice(0, 16);
}

export function sanitizeFirebasePath(input) {
  if (!input || typeof input !== "string") return "unknown";
  return input
    .replace(/\./g, "_")
    .replace(/#/g, "_")
    .replace(/\$/g, "_")
    .replace(/\[/g, "_")
    .replace(/\]/g, "_")
    .replace(/\//g, "_")
    .replace(/\\/g, "_")
    .slice(0, 100);
}

// =========================================================================
// Activity logs
// =========================================================================

const LOG_LIMIT = 500;
const LOG_BUFFER = 50;

async function trimLogs(path, max = LOG_LIMIT) {
  const snap = await db.ref(path).once("value");
  if (!snap.exists()) return;
  const entries = [];
  snap.forEach(child => entries.push({ key: child.key, ts: child.val().ts || 0 }));
  if (entries.length <= max + LOG_BUFFER) return;
  entries.sort((a, b) => a.ts - b.ts);
  const toDelete = entries.slice(0, entries.length - max);
  const updates = {};
  toDelete.forEach(e => { updates[e.key] = null; });
  await db.ref(path).update(updates);
}

export async function logUserEvent(uid, type, action, meta = {}) {
  if (!uid) return;
  const logId = `log_${Date.now()}_${crypto.randomBytes(3).toString("hex")}`;
  await db.ref(`logs/user/${uid}/${logId}`).set({
    ts: Date.now(),
    type,
    action,
    meta,
  });
  await trimLogs(`logs/user/${uid}`);
}

export async function logProjectEvent(pid, uid, type, action, meta = {}) {
  if (!pid) return;
  const logId = `log_${Date.now()}_${crypto.randomBytes(3).toString("hex")}`;
  await db.ref(`logs/project/${pid}/${logId}`).set({
    ts: Date.now(),
    uid: uid || null,
    type,
    action,
    meta,
  });
  await trimLogs(`logs/project/${pid}`);
}