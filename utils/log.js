// utils/log.js
import crypto from "node:crypto";

/**
 * Generate a short request ID for correlating log lines within one invocation.
 * Not cryptographic — just unique enough to tie lines together.
 */
export function newReqId() {
  return `req_${Date.now().toString(36)}_${crypto.randomBytes(3).toString("hex")}`;
}

/**
 * Emit a single structured log line to the platform log (Vercel).
 * This is the DEVELOPER log, not the user activity log in RTDB
 * (that's logUserEvent / logProjectEvent in utils/users.js).
 *
 * @param {string} event  short event name (e.g. "deploy.start", "invite.accept")
 * @param {object} fields arbitrary key/values (keep small, no secrets)
 */
export function log(event, fields = {}) {
  const line = {
    ts: new Date().toISOString(),
    event,
    ...fields,
  };
  // JSON so Vercel's log viewer can expand fields.
  try {
    console.log(JSON.stringify(line));
  } catch {
    // Never throw from logging.
    console.log(`[log] ${event}`);
  }
}