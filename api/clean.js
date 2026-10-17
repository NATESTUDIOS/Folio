// api/cron/cleanup.js
import { db } from "../../utils/firebase.js";
import { log, newReqId } from "../../utils/log.js";

// Vercel cron sends `Authorization: Bearer ${CRON_SECRET}`.
// Also accept `X-API-Key: ADMIN_API_KEY` for manual runs.
function isAuthorized(req) {
  const auth = req.headers.authorization || "";
  const apiKey = req.headers["x-api-key"] || "";

  const cronSecret = process.env.CRON_SECRET || "";
  if (cronSecret && auth === `Bearer ${cronSecret}`) return true;

  const adminKey = process.env.ADMIN_API_KEY || "";
  if (adminKey && apiKey === adminKey) return true;

  return false;
}

export default async function handler(req, res) {
  const reqId = newReqId();
  res.setHeader("X-Request-Id", reqId);

  if (!isAuthorized(req)) {
    return res.status(401).json({ success: false, error: "Unauthorized" });
  }

  // Only DELETE counters older than 1 hour. Most rate-limit windows
  // are ≤1h, so expired counters would be overwritten on next write
  // anyway. This sweep prevents the map from growing unbounded.
  const cutoff = Date.now() - 60 * 60 * 1000;
  let deleted = 0;
  let scanned = 0;

  try {
    const snap = await db.ref("rate_limit").once("value");
    if (!snap.exists()) {
      log("cron.cleanup.empty", { reqId });
      return res.status(200).json({ success: true, deleted: 0, scanned: 0 });
    }

    const updates = {};
    snap.forEach(apiChild => {
      apiChild.forEach(actionChild => {
        actionChild.forEach(keyChild => {
          scanned++;
          const v = keyChild.val();
          if (v && typeof v.first_request === "number" && v.first_request < cutoff) {
            updates[`${apiChild.key}/${actionChild.key}/${keyChild.key}`] = null;
            deleted++;
          }
        });
      });
    });

    if (deleted > 0) {
      await db.ref("rate_limit").update(updates);
    }

    log("cron.cleanup.done", { reqId, scanned, deleted });
    return res.status(200).json({ success: true, scanned, deleted });
  } catch (err) {
    log("cron.cleanup.failed", { reqId, message: err.message });
    return res.status(500).json({ success: false, error: "Cleanup failed" });
  }
}

export const config = { runtime: "nodejs" };