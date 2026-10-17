// api/auth.js
import crypto from "node:crypto";
import { db } from "../utils/firebase.js";
import { log, newReqId } from "../utils/log.js";
import {
  signSession, verifySession,
  requireAuth,
  hashPassword, verifyPassword, validatePassword, dummyHash,
  getUser, getUserByEmail, getUserByUsername,
  cleanUsername, cleanEmail, isReservedUsername,
  assignUsername, reserveEmail, reserveUsername,
  releaseEmail, releaseUsername,
  getClientIp, hashIp, sanitizeFirebasePath,
  logUserEvent,
} from "../utils/users.js";

// =========================================================================
// RATE LIMITS
// =========================================================================

const API_NAME = "auth";

const RATE_LIMITS = {
  register:       { max: 5,   window: 60 * 60 * 1000 },
  login:          { max: 10,  window: 60 * 60 * 1000 },
  loginByIdent:   { max: 5,   window: 15 * 60 * 1000 },
  logout:         { max: 30,  window: 60 * 60 * 1000 },
  refresh:        { max: 20,  window: 60 * 60 * 1000 },
  changePassword: { max: 5,   window: 60 * 60 * 1000 },
  changeEmail:    { max: 3,   window: 60 * 60 * 1000 },
  changeUsername: { max: 3,   window: 60 * 60 * 1000 },
  me:             { max: 300, window: 60 * 60 * 1000 },
  profileUpdate:  { max: 10,  window: 60 * 60 * 1000 },
  logs:           { max: 60,  window: 60 * 60 * 1000 },
};

async function checkRateLimit(identifier, action) {
  const config = RATE_LIMITS[action];
  if (!config) return { allowed: true, remaining: Infinity, limit: Infinity, reset: null };
  const now = Date.now();
  const key = sanitizeFirebasePath(String(identifier).toLowerCase());
  const ref = db.ref(`rate_limit/${API_NAME}/${action}/${key}`);
  const snap = await ref.once("value");

  if (!snap.exists()) {
    await ref.set({ count: 1, first_request: now, last_request: now });
    return { allowed: true, remaining: config.max - 1, limit: config.max,
             reset: new Date(now + config.window).toISOString() };
  }
  const d = snap.val();
  const resetAt = (d.first_request || now) + config.window;
  if (now > resetAt) {
    await ref.set({ count: 1, first_request: now, last_request: now });
    return { allowed: true, remaining: config.max - 1, limit: config.max,
             reset: new Date(now + config.window).toISOString() };
  }
  if ((d.count || 0) >= config.max) {
    return { allowed: false, remaining: 0, limit: config.max,
             reset: new Date(resetAt).toISOString(),
             retryAfter: Math.ceil((resetAt - now) / 1000) };
  }
  await ref.update({ count: (d.count || 0) + 1, last_request: now });
  return { allowed: true, remaining: config.max - (d.count || 0) - 1,
           limit: config.max, reset: new Date(resetAt).toISOString() };
}

function setRateHeaders(res, r) {
  if (!r) return;
  if (Number.isFinite(r.limit)) res.setHeader("X-RateLimit-Limit", String(r.limit));
  if (Number.isFinite(r.remaining)) res.setHeader("X-RateLimit-Remaining", String(r.remaining));
  if (r.reset) res.setHeader("X-RateLimit-Reset", r.reset);
}

async function enforceRate(req, res, action, identifier) {
  const r = await checkRateLimit(identifier, action);
  setRateHeaders(res, r);
  if (!r.allowed) {
    res.status(429).json({
      success: false,
      error: "Rate limit exceeded",
      retryAfter: r.retryAfter,
      reset: r.reset,
    });
    return false;
  }
  return true;
}

function ipKey(req) {
  return `ip_${hashIp(getClientIp(req))}`;
}

// =========================================================================
// HELPERS
// =========================================================================

const BASE_URL = process.env.BASE_URL || "https://foliostudios.vercel.app";
const LOGIN_MAX_FAILURES = 5;
const LOGIN_LOCK_MS = 15 * 60 * 1000;

async function createUserRecord({ uid, email, emailLower, passwordHash, username, displayName }) {
  const now = Date.now();
  const record = {
    email,
    emailLower,
    passwordHash,
    profile: {
      username,
      displayName: displayName || username,
      bio: "",
      avatarUrl: null,
      links: {},
      ogImageUrl: null,
    },
    projectIds: {},
    settings: {
      theme: "auto",
      editorPrefs: {
        fontSize: 14,
        tabSize: 2,
        softTabs: true,
        lineNumbers: true,
        wrap: true,
        lineHeight: 1.5,
      },
      globalLimit: 10 * 1024 * 1024,
      notifications: {},
    },
    mode: "active",
    createdAt: now,
    updatedAt: now,
    lastLoginAt: now,
  };
  await db.ref(`users/${uid}`).set(record);
  return record;
}

async function callNotifyBridge(action, uid, extra = {}) {
  try {
    const res = await fetch(`${BASE_URL}/api/notify?action=${action}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": process.env.ADMIN_API_KEY || "",
      },
      body: JSON.stringify({ uid, ...extra }),
    });
    if (!res.ok) {
      log("auth.notify_bridge_failed", { action, uid, status: res.status });
    }
  } catch (err) {
    log("auth.notify_bridge_error", { action, uid, message: err.message });
  }
}

// =========================================================================
// VAPID (Web Push)
// =========================================================================

async function handleVapid(req, res, reqId) {
  const key = process.env.VAPID_PUBLIC_KEY;
  if (!key) {
    return res.status(503).json({ success: false, error: "Push not configured" });
  }
  res.setHeader("Cache-Control", "public, max-age=86400");
  return res.status(200).json({ success: true, publicKey: key });
}

// =========================================================================
// ENDPOINTS
// =========================================================================

async function handleRegister(req, res, reqId) {
  if (!(await enforceRate(req, res, "register", ipKey(req)))) return;

  const { email, password, username, displayName } = req.body || {};

  const emailLower = cleanEmail(email);
  if (!emailLower) {
    return res.status(400).json({ success: false, error: "Invalid email" });
  }
  const pwErr = validatePassword(password);
  if (pwErr) return res.status(400).json({ success: false, error: pwErr });

  const cleanedUsername = cleanUsername(username);
  if (!cleanedUsername) {
    return res.status(400).json({ success: false, error: "Invalid username (3-30 chars, a-z 0-9 _ -)" });
  }
  if (isReservedUsername(cleanedUsername)) {
    return res.status(400).json({ success: false, error: "Username is reserved" });
  }

  const existing = await getUserByEmail(emailLower);
  if (existing) {
    return res.status(409).json({ success: false, error: "Email already registered" });
  }

  const uid = "u_" + crypto.randomBytes(10).toString("hex");
  const passwordHash = hashPassword(password);

  let reservedEmailOk = false;
  let assigned = null;
  try {
    reservedEmailOk = await reserveEmail(emailLower, uid);
    if (!reservedEmailOk) {
      return res.status(409).json({ success: false, error: "Email already registered" });
    }

    assigned = await assignUsername(cleanedUsername, uid);
    if (!assigned) {
      await releaseEmail(emailLower);
      return res.status(409).json({ success: false, error: "Could not allocate a username" });
    }

    await createUserRecord({
      uid,
      email,
      emailLower,
      passwordHash,
      username: assigned.username,
      displayName,
    });
  } catch (err) {
    log("auth.register_failed", { reqId, message: err.message });
    try {
      if (reservedEmailOk) await releaseEmail(emailLower);
      if (assigned) await releaseUsername(assigned.username);
    } catch (cleanupErr) {
      log("auth.register_cleanup_failed", { reqId, message: cleanupErr.message });
    }
    return res.status(500).json({ success: false, error: "Registration failed" });
  }

  callNotifyBridge("auth_signup", uid, { username: assigned.username }).catch(() => {});

  await logUserEvent(uid, "auth", "user.registered", {
    email: emailLower,
    username: assigned.username,
    requestedUsername: cleanedUsername,
    wasModified: assigned.isModified,
  });

  const sessionToken = signSession(uid, assigned.username);

  return res.status(200).json({
    success: true,
    uid,
    username: assigned.username,
    requestedUsername: cleanedUsername,
    usernameModified: assigned.isModified,
    sessionToken,
    expiresIn: "30d",
  });
}

async function handleLogin(req, res, reqId) {
  if (!(await enforceRate(req, res, "login", ipKey(req)))) return;

  const { identifier, password } = req.body || {};
  if (!identifier || !password) {
    return res.status(400).json({ success: false, error: "Missing credentials" });
  }

  const idHash = crypto.createHash("sha256").update(String(identifier).toLowerCase()).digest("hex").slice(0, 32);
  if (!(await enforceRate(req, res, "loginByIdent", `id_${idHash}`))) return;

  const isEmail = String(identifier).includes("@");
  const found = isEmail
    ? await getUserByEmail(identifier)
    : await getUserByUsername(identifier);

  if (!found) {
    dummyHash();
    return res.status(401).json({ success: false, error: "Invalid credentials" });
  }

  if (found.mode === "banned") {
    return res.status(403).json({ success: false, error: "Account suspended" });
  }

  const attemptsRef = db.ref(`loginAttempts/${idHash}`);
  const attemptsSnap = await attemptsRef.once("value");
  const attempts = attemptsSnap.val() || { count: 0, lastAttempt: 0, lockedUntil: 0 };
  if (attempts.lockedUntil && attempts.lockedUntil > Date.now()) {
    return res.status(429).json({
      success: false,
      error: "Too many failed attempts. Try again later.",
      retryAfter: Math.ceil((attempts.lockedUntil - Date.now()) / 1000),
    });
  }

  const pwOk = verifyPassword(password, found.passwordHash);
  if (!pwOk) {
    log("auth.login.password_failed", { reqId, uid: found.uid, hasHash: !!found.passwordHash });
    const now = Date.now();
    const newCount = (attempts.count || 0) + 1;
    const lockedUntil = newCount >= LOGIN_MAX_FAILURES ? now + LOGIN_LOCK_MS : 0;
    await attemptsRef.set({ count: newCount, lastAttempt: now, lockedUntil });
    return res.status(401).json({ success: false, error: "Invalid credentials" });
  }

  await attemptsRef.remove();
  await db.ref(`users/${found.uid}/lastLoginAt`).set(Date.now());

  const sessionToken = signSession(found.uid, found.profile?.username || "");

  await logUserEvent(found.uid, "auth", "user.login", {
    identifierType: isEmail ? "email" : "username",
  });

  return res.status(200).json({
    success: true,
    uid: found.uid,
    sessionToken,
    expiresIn: "30d",
    user: {
      username: found.profile?.username || null,
      displayName: found.profile?.displayName || null,
      email: found.email,
    },
  });
}

async function handleLogout(req, res, reqId) {
  const user = await requireAuth(req, res);
  if (!user) return;
  if (!(await enforceRate(req, res, "logout", `uid_${user.uid}`))) return;

  callNotifyBridge("auth_logout", user.uid).catch(() => {});
  await logUserEvent(user.uid, "auth", "user.logout", {});

  return res.status(200).json({ success: true });
}

async function handleRefresh(req, res, reqId) {
  const user = await requireAuth(req, res);
  if (!user) return;
  if (!(await enforceRate(req, res, "refresh", `uid_${user.uid}`))) return;

  const exp = user.session?.exp || 0;
  const nowSec = Math.floor(Date.now() / 1000);
  const remaining = exp - nowSec;

  if (remaining > 7 * 24 * 60 * 60) {
    return res.status(200).json({ success: true, sessionToken: null, reason: "not_needed" });
  }

  const newToken = signSession(user.uid, user.profile?.username || "");
  return res.status(200).json({ success: true, sessionToken: newToken, expiresIn: "30d" });
}

async function handleChangePassword(req, res, reqId) {
  const user = await requireAuth(req, res);
  if (!user) return;
  if (!(await enforceRate(req, res, "changePassword", `uid_${user.uid}`))) return;

  const { currentPassword, newPassword } = req.body || {};
  if (!verifyPassword(currentPassword, user.passwordHash)) {
    log("auth.change_password.bad_current", { reqId, uid: user.uid });
    return res.status(401).json({ success: false, error: "Current password incorrect" });
  }
  const pwErr = validatePassword(newPassword);
  if (pwErr) return res.status(400).json({ success: false, error: pwErr });

  const newHash = hashPassword(newPassword);
  await db.ref(`users/${user.uid}/passwordHash`).set(newHash);
  await db.ref(`users/${user.uid}/updatedAt`).set(Date.now());
  await logUserEvent(user.uid, "auth", "password.changed", {});

  return res.status(200).json({ success: true });
}

async function handleChangeEmail(req, res, reqId) {
  const user = await requireAuth(req, res);
  if (!user) return;
  if (!(await enforceRate(req, res, "changeEmail", `uid_${user.uid}`))) return;

  const { password, newEmail } = req.body || {};
  if (!verifyPassword(password, user.passwordHash)) {
    return res.status(401).json({ success: false, error: "Password incorrect" });
  }
  const newLower = cleanEmail(newEmail);
  if (!newLower) return res.status(400).json({ success: false, error: "Invalid email" });
  if (newLower === user.emailLower) {
    return res.status(400).json({ success: false, error: "That is your current email" });
  }

  const existing = await getUserByEmail(newLower);
  if (existing) return res.status(409).json({ success: false, error: "Email already registered" });

  const oldLower = user.emailLower;
  const reserved = await reserveEmail(newLower, user.uid);
  if (!reserved) {
    return res.status(409).json({ success: false, error: "Email already registered" });
  }

  try {
    await db.ref(`users/${user.uid}`).update({
      email: newEmail,
      emailLower: newLower,
      updatedAt: Date.now(),
    });
    await releaseEmail(oldLower);
  } catch (err) {
    log("auth.change_email.write_failed", { reqId, uid: user.uid, message: err.message });
    try { await releaseEmail(newLower); } catch {}
    return res.status(500).json({ success: false, error: "Email change failed" });
  }

  await logUserEvent(user.uid, "auth", "email.changed", {});
  return res.status(200).json({ success: true });
}

async function handleChangeUsername(req, res, reqId) {
  const user = await requireAuth(req, res);
  if (!user) return;
  if (!(await enforceRate(req, res, "changeUsername", `uid_${user.uid}`))) return;

  const { password, newUsername } = req.body || {};
  if (!verifyPassword(password, user.passwordHash)) {
    return res.status(401).json({ success: false, error: "Password incorrect" });
  }
  const newName = cleanUsername(newUsername);
  if (!newName) return res.status(400).json({ success: false, error: "Invalid username" });
  if (isReservedUsername(newName)) return res.status(400).json({ success: false, error: "Username is reserved" });
  if (newName === user.profile?.username) {
    return res.status(400).json({ success: false, error: "That is your current username" });
  }

  const existing = await getUserByUsername(newName);
  if (existing) return res.status(409).json({ success: false, error: "Username already taken" });

  const oldName = user.profile?.username;
  const reserved = await reserveUsername(newName, user.uid);
  if (!reserved) return res.status(409).json({ success: false, error: "Username already taken" });

  try {
    await db.ref(`users/${user.uid}/profile/username`).set(newName);
    await db.ref(`users/${user.uid}/updatedAt`).set(Date.now());
    if (oldName) await db.ref(`previousUsernames/${oldName}`).set(newName);
    if (oldName) await releaseUsername(oldName);
  } catch (err) {
    log("auth.change_username.write_failed", { reqId, uid: user.uid, message: err.message });
    try { await releaseUsername(newName); } catch {}
    return res.status(500).json({ success: false, error: "Username change failed" });
  }

  await logUserEvent(user.uid, "auth", "username.changed", { from: oldName, to: newName });

  const sessionToken = signSession(user.uid, newName);
  return res.status(200).json({ success: true, sessionToken, username: newName });
}

async function handleMe(req, res, reqId) {
  const user = await requireAuth(req, res);
  if (!user) return;
  if (!(await enforceRate(req, res, "me", `uid_${user.uid}`))) return;

  return res.status(200).json({
    success: true,
    user: {
      uid: user.uid,
      email: user.email,
      profile: user.profile,
      settings: user.settings,
      projectIds: user.projectIds || {},
      mode: user.mode,
      createdAt: user.createdAt,
      lastLoginAt: user.lastLoginAt,
    },
  });
}

async function handleProfileUpdate(req, res, reqId) {
  const user = await requireAuth(req, res);
  if (!user) return;
  if (!(await enforceRate(req, res, "profileUpdate", `uid_${user.uid}`))) return;

  const { displayName, bio, avatarUrl, links, avatarDataUrl } = req.body || {};
  const patch = {};

  if (displayName !== undefined) {
    if (typeof displayName !== "string" || displayName.length < 1 || displayName.length > 60) {
      return res.status(400).json({ success: false, error: "displayName must be 1–60 chars" });
    }
    patch["profile/displayName"] = displayName;
  }
  if (bio !== undefined) {
    if (typeof bio !== "string" || bio.length > 500) {
      return res.status(400).json({ success: false, error: "bio must be ≤500 chars" });
    }
    patch["profile/bio"] = bio;
  }
  if (avatarUrl !== undefined) {
    if (avatarUrl !== null) {
      try {
        const u = new URL(avatarUrl);
        if (u.protocol !== "https:") throw new Error("must be https");
      } catch {
        return res.status(400).json({ success: false, error: "avatarUrl must be an HTTPS URL or null" });
      }
    }
    patch["profile/avatarUrl"] = avatarUrl;
  }

  if (avatarDataUrl && typeof avatarDataUrl === "string") {
    if (avatarDataUrl.length > 3 * 1024 * 1024) {
      return res.status(413).json({ success: false, error: "Avatar too large (max 2 MB)" });
    }
    if (!avatarDataUrl.startsWith("data:image/")) {
      return res.status(400).json({ success: false, error: "Invalid image data" });
    }
    try {
      const uploadApi = process.env.IMAGE_UPLOAD_API || "https://kx-services.vercel.app/api/tools/imageupload";
      const upRes = await fetch(uploadApi, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${process.env.ADMIN_API_KEY || ""}`,
          "x-api-key": process.env.ADMIN_API_KEY || "",
        },
        body: JSON.stringify({
          image: avatarDataUrl.split(",")[1],
          name: `avatar_${user.uid}_${Date.now()}`,
        }),
        signal: AbortSignal.timeout(20000),
      });
      const upBody = await upRes.json().catch(() => ({}));
      const uploadedUrl = upBody.data?.url || upBody.data?.display_url;
      if (!upRes.ok || !uploadedUrl) {
        throw new Error(upBody?.error?.message || "upload failed");
      }
      patch["profile/avatarUrl"] = uploadedUrl;
    } catch (err) {
      log("auth.avatar_upload_failed", { reqId, uid: user.uid, message: err.message });
      return res.status(502).json({ success: false, error: "Avatar upload failed" });
    }
  }

  if (links !== undefined) {
    if (typeof links !== "object" || links === null || Array.isArray(links)) {
      return res.status(400).json({ success: false, error: "links must be an object" });
    }
    const cleanLinks = {};
    for (const [k, v] of Object.entries(links)) {
      if (typeof k !== "string" || k.length > 40) {
        return res.status(400).json({ success: false, error: `Invalid link key: ${k}` });
      }
      if (typeof v !== "string" || v.length > 500) {
        return res.status(400).json({ success: false, error: `Invalid link value for ${k}` });
      }
      try {
        const u = new URL(v);
        if (u.protocol !== "https:") throw new Error("must be https");
      } catch {
        return res.status(400).json({ success: false, error: `Link ${k} must be an HTTPS URL` });
      }
      cleanLinks[k] = v;
    }
    patch["profile/links"] = cleanLinks;
  }
  if (Object.keys(patch).length === 0) {
    return res.status(400).json({ success: false, error: "No fields to update" });
  }

  patch.updatedAt = Date.now();
  await db.ref(`users/${user.uid}`).update(patch);
  await logUserEvent(user.uid, "settings", "profile.updated", {
    fields: Object.keys(patch).filter(k => k.startsWith("profile/")),
  });

  const fresh = await getUser(user.uid);
  return res.status(200).json({ success: true, profile: fresh.profile });
}

async function handleLogs(req, res, reqId) {
  const user = await requireAuth(req, res);
  if (!user) return;
  if (!(await enforceRate(req, res, "logs", `uid_${user.uid}`))) return;

  const limit = Math.min(Math.max(parseInt(req.query?.limit, 10) || 50, 1), 200);
  const offset = Math.max(parseInt(req.query?.offset, 10) || 0, 0);
  const typeFilter = String(req.query?.type || "all");

  const snap = await db.ref(`logs/user/${user.uid}`).once("value");
  if (!snap.exists()) {
    return res.status(200).json({ success: true, logs: [], total: 0, hasMore: false });
  }

  const all = [];
  snap.forEach(child => {
    const v = child.val();
    if (typeFilter !== "all" && v.type !== typeFilter) return;
    all.push({ id: child.key, ...v });
  });
  all.sort((a, b) => (b.ts || 0) - (a.ts || 0));

  const slice = all.slice(offset, offset + limit);
  return res.status(200).json({
    success: true,
    logs: slice,
    total: all.length,
    hasMore: offset + limit < all.length,
  });
}

// =========================================================================
// ROUTER
// =========================================================================

export default async function handler(req, res) {
  const reqId = newReqId();
  res.setHeader("X-Request-Id", reqId);

  res.setHeader("Access-Control-Allow-Origin", BASE_URL);
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.setHeader("Access-Control-Allow-Credentials", "true");
  if (req.method === "OPTIONS") return res.status(204).end();

  const action = String(req.query?.action || req.body?.action || "").trim();
  const method = req.method;

  try {
    if (method === "GET"  && action === "vapid")           return await handleVapid(req, res, reqId);
    if (method === "POST" && action === "register")        return await handleRegister(req, res, reqId);
    if (method === "POST" && action === "login")           return await handleLogin(req, res, reqId);
    if (method === "POST" && action === "logout")          return await handleLogout(req, res, reqId);
    if (method === "POST" && action === "refresh")         return await handleRefresh(req, res, reqId);
    if (method === "POST" && action === "change-password") return await handleChangePassword(req, res, reqId);
    if (method === "POST" && action === "change-email")    return await handleChangeEmail(req, res, reqId);
    if (method === "POST" && action === "change-username") return await handleChangeUsername(req, res, reqId);
    if (method === "GET"  && action === "me")              return await handleMe(req, res, reqId);
    if (method === "POST" && action === "profile/update")  return await handleProfileUpdate(req, res, reqId);
    if (method === "GET"  && action === "logs")            return await handleLogs(req, res, reqId);

    return res.status(404).json({ success: false, error: `Unknown action: ${action || "(none)"}` });
  } catch (err) {
    log("auth.unhandled_error", { reqId, action, method, message: err.message, stack: err.stack });
    return res.status(500).json({ success: false, error: "Internal error", reqId });
  }
}

export const config = { runtime: "nodejs" };