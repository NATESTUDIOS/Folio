// api/analytics.js
import crypto from "node:crypto";
import { db } from "../utils/firebase.js";
import { log, newReqId } from "../utils/log.js";
import {
  requireAuth, requireProjectRole,
  getClientIp, hashIp, sanitizeFirebasePath,
} from "../utils/users.js";

// =========================================================================
// RATE LIMITS (per-API, Final Rule #16)
// =========================================================================

const API_NAME = "analytics";

const RATE_LIMITS = {
  hit:           { max: 60,    window: 60 * 1000 },
  hitByProject:  { max: 10000, window: 60 * 60 * 1000 },
  projectQuery:  { max: 120,   window: 60 * 60 * 1000 },
  profileQuery:  { max: 120,   window: 60 * 60 * 1000 },
  activityQuery: { max: 120,   window: 60 * 60 * 1000 },
};

async function checkRateLimit(identifier, action) {
  const config = RATE_LIMITS[action];
  if (!config) return { allowed: true };

  const now = Date.now();
  const windowStart = now - config.window;
  const key = sanitizeFirebasePath(String(identifier).toLowerCase());
  const ref = db.ref(`rate_limit/${API_NAME}/${action}/${key}`);

  let result = { allowed: true, remaining: config.max - 1, limit: config.max };

  try {
    await ref.transaction(current => {
      if (!current || current.first_request < windowStart) {
        result = { allowed: true, remaining: config.max - 1, limit: config.max };
        return { count: 1, first_request: now, last_request: now };
      }
      if (current.count >= config.max) {
        const resetAt = current.first_request + config.window;
        result = {
          allowed: false,
          remaining: 0,
          limit: config.max,
          reset: resetAt,
          retryAfter: Math.ceil((resetAt - now) / 1000),
        };
        return;
      }
      result = { allowed: true, remaining: config.max - current.count - 1, limit: config.max };
      return {
        count: current.count + 1,
        first_request: current.first_request,
        last_request: now,
      };
    });
  } catch (err) {
    log("analytics.rate_limit_failed", { action, message: err.message });
    return { allowed: true, remaining: config.max, limit: config.max };
  }

  return result;
}

function setRateHeaders(res, r) {
  if (!r) return;
  if (Number.isFinite(r.limit)) res.setHeader("X-RateLimit-Limit", String(r.limit));
  if (Number.isFinite(r.remaining)) res.setHeader("X-RateLimit-Remaining", String(r.remaining));
  if (r.reset) res.setHeader("X-RateLimit-Reset", String(Math.ceil(r.reset / 1000)));
}

async function enforceRate(res, action, identifier) {
  const r = await checkRateLimit(identifier, action);
  setRateHeaders(res, r);
  if (!r.allowed) {
    res.status(429).json({
      success: false,
      error: "Rate limit exceeded",
      retryAfter: r.retryAfter,
    });
    return false;
  }
  return true;
}

// =========================================================================
// 🆕 NOTIFICATIONS — helpers
// =========================================================================

const BASE_URL = process.env.BASE_URL || "https://foliostudios.vercel.app";

async function callNotify(type, uid, payload) {
  if (!uid) return;
  try {
    const res = await fetch(`${BASE_URL}/api/notify?action=create`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": process.env.ADMIN_API_KEY || "",
      },
      body: JSON.stringify({ type, uid, ...payload }),
    });
    if (!res.ok) log("analytics.notify_failed", { type, uid, status: res.status });
  } catch (err) {
    log("analytics.notify_error", { type, uid, message: err.message });
  }
}

// Fire-once-per-window dedupe (mirrors host.js helper).
async function shouldNotifyOnce(uid, key, ttlMs = 24 * 60 * 60 * 1000) {
  if (!uid) return false;
  try {
    const ref = db.ref(`notify_dedupe/${uid}/${sanitizeFirebasePath(key)}`);
    const snap = await ref.once("value");
    const now = Date.now();
    if (snap.exists() && now - (snap.val()?.ts || 0) < ttlMs) return false;
    await ref.set({ ts: now }).catch(() => {});
    return true;
  } catch {
    return true;
  }
}

// Milestones for traffic-spike notifications. Only these counts are checked —
// per-hit cost stays O(1) on non-milestone hits.
const SPIKE_MILESTONES = [
  20, 50, 100, 250, 500, 1000, 2500, 5000, 10000, 25000, 50000, 100000,
];

/**
 * A1 + A5 — Evaluates a milestone crossing against the 7-day baseline.
 * Fires exactly one notification if the threshold is met.
 *
 * 🆕 Now awaited by callers — previously fire-and-forget, which caused
 * Vercel to kill the request before the notify API call completed.
 */
async function evaluateTrafficSpike(pid, todayCount, milestone) {
  try {
    // A5 — hard viral threshold (10k/day), skip baseline check.
    if (milestone === 10000) {
      const ownerSnap = await db.ref(`projects/${pid}/ownerId`).once("value");
      if (!ownerSnap.exists()) return;
      if (!(await shouldNotifyOnce(ownerSnap.val(), `viral_${pid}_${dayString()}`, 24 * 60 * 60 * 1000))) return;
      await callNotify("analytics", ownerSnap.val(), {
        title: "🎉 10,000 visits today",
        body: `Your project just crossed 10k visits in a single day.`,
        link: `${BASE_URL}/project.html?pid=${pid}`,
        extra: { pid, milestone, kind: "viral" },
        dedupeKey: `viral_${pid}_${dayString()}`,
      });
      return;
    }

    // A1 — 3× baseline spike. Skip tiny milestones that never qualify.
    if (milestone < 20) return;

    // Read last 7 days (excluding today) of rollups.
    let sum = 0;
    let counted = 0;
    for (let i = 1; i <= 7; i++) {
      const s = await db.ref(`analytics/${pid}/rollups/${daysAgo(i)}/count`).once("value");
      if (s.exists()) {
        sum += s.val() || 0;
        counted++;
      }
    }
    if (counted === 0) return; // no history yet — not a spike
    const avg = sum / counted;

    // Require: min 20 hits today AND 3× the rolling average.
    if (todayCount < 20) return;
    if (todayCount < avg * 3) return;

    const ownerSnap = await db.ref(`projects/${pid}/ownerId`).once("value");
    if (!ownerSnap.exists()) return;

    await callNotify("analytics", ownerSnap.val(), {
      title: "Traffic spike detected",
      body: `Today's traffic (${todayCount} hits) is ${(todayCount / Math.max(avg, 1)).toFixed(1)}× your 7-day average.`,
      link: `${BASE_URL}/project.html?pid=${pid}`,
      extra: { pid, todayCount, avg7: Math.round(avg), milestone, kind: "spike" },
      dedupeKey: `spike_${pid}`,
    });
  } catch (err) {
    log("analytics.spike_eval_failed", { pid, milestone, message: err.message });
  }
}

/**
 * A2 — First hit after (re)deploy. Only checks when todayCount === 1.
 * 🆕 Awaited by caller.
 */
async function evaluateFirstHitAfterDeploy(pid, todayCount) {
  if (todayCount !== 1) return;
  try {
    const deployedSnap = await db.ref(`projects/${pid}/deployment/deployedAt`).once("value");
    if (!deployedSnap.exists()) return;
    const deployedAt = deployedSnap.val() || 0;
    if (!deployedAt) return;

    const fpSnap = await db.ref(`projects/${pid}/analytics_last_first_hit_deploy`).once("value");
    const lastNotified = fpSnap.exists() ? fpSnap.val() : 0;
    if (lastNotified === deployedAt) return;

    await db.ref(`projects/${pid}/analytics_last_first_hit_deploy`).set(deployedAt).catch(() => {});

    const ownerSnap = await db.ref(`projects/${pid}/ownerId`).once("value");
    if (!ownerSnap.exists()) return;

    const nameSnap = await db.ref(`projects/${pid}/name`).once("value");
    const pname = nameSnap.exists() ? nameSnap.val() : "your project";

    await callNotify("analytics", ownerSnap.val(), {
      title: "First visit after deploy",
      body: `"${pname}" received its first visitor since going live.`,
      link: `${BASE_URL}/project.html?pid=${pid}`,
      extra: { pid, deployedAt, kind: "first_hit" },
      dedupeKey: `first_hit_${pid}_${deployedAt}`,
    });
  } catch (err) {
    log("analytics.first_hit_eval_failed", { pid, message: err.message });
  }
}

/**
 * A3 — Referrer flood. Only checks when count exactly hits the threshold.
 * 🆕 Awaited by caller.
 */
async function evaluateReferrerFlood(pid, hour, referrer, count) {
  // Fire only when we hit the threshold exactly (500). Avoids repeated notifies.
  if (count !== 500) return;
  try {
    const ownerSnap = await db.ref(`projects/${pid}/ownerId`).once("value");
    if (!ownerSnap.exists()) return;

    await callNotify("security", ownerSnap.val(), {
      title: "Unusual traffic source",
      body: `A single referrer has sent 500+ hits this hour. Possible bot attack or embed surge.`,
      link: `${BASE_URL}/project.html?pid=${pid}`,
      extra: {
        pid,
        hour,
        referrer: String(referrer || "").slice(0, 100),
        kind: "referrer_flood",
      },
      dedupeKey: `ref_flood_${pid}_${hour}`,
    });
  } catch (err) {
    log("analytics.ref_flood_eval_failed", { pid, hour, message: err.message });
  }
}

/**
 * A4 — Bot flood. Sampled 1:10, so threshold is 20 (=200 real).
 * 🆕 Awaited by caller.
 */
async function evaluateBotFlood(projectId, bucket, sampledCount) {
  if (sampledCount !== 20) return;
  try {
    const ownerSnap = await db.ref(`projects/${projectId}/ownerId`).once("value");
    if (!ownerSnap.exists()) return;

    await callNotify("security", ownerSnap.val(), {
      title: "Bot activity detected",
      body: `200+ bot requests in the last 10 minutes. Your site may be getting scraped.`,
      link: `${BASE_URL}/project.html?pid=${projectId}`,
      extra: { pid: projectId, bucket, kind: "bot_flood" },
      dedupeKey: `bot_flood_${projectId}_${bucket}`,
    });
  } catch (err) {
    log("analytics.bot_flood_eval_failed", { projectId, bucket, message: err.message });
  }
}

// =========================================================================
// HELPERS
// =========================================================================

const BOT_UA_RE = /bot|crawler|spider|preview|curl|wget|python-requests|httpclient/i;

function isBot(req) {
  const ua = req.headers["user-agent"] || "";
  return BOT_UA_RE.test(ua);
}

function dayString(d = new Date()) {
  return d.toISOString().slice(0, 10);
}

function daysAgo(n) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - n);
  return dayString(d);
}

function pathHash(path) {
  return crypto.createHash("sha256").update(String(path || "/")).digest("hex").slice(0, 8);
}

/**
 * Merge daily count nodes into a flat trend array.
 * Fetches N most recent days and returns [{date, count}] oldest→newest.
 */
async function readDailyTrend(pid, days) {
  const dates = [];
  for (let i = days - 1; i >= 0; i--) dates.push(daysAgo(i));
  const trend = [];
  for (const date of dates) {
    const snap = await db.ref(`analytics/${pid}/hits/${date}`).once("value");
    let count = 0;
    if (snap.exists()) {
      snap.forEach(child => {
        count += (child.val()?.count || 0);
      });
    }
    trend.push({ date, count });
  }
  return trend;
}

/**
 * Sum all hits under analytics/{pid}/hits/* — used only for "total" tile.
 */
async function readTotalHits(pid) {
  const snap = await db.ref(`analytics/${pid}/hits`).once("value");
  if (!snap.exists()) return 0;
  let total = 0;
  snap.forEach(day => {
    day.forEach(hash => {
      total += (hash.val()?.count || 0);
    });
  });
  return total;
}

/**
 * Top pages across the last N days. Paths stored separately under
 * analytics/{pid}/paths/{hash} — join client-side after aggregating.
 */
async function readTopPages(pid, days, limit = 10) {
  const byHash = new Map();
  for (let i = 0; i < days; i++) {
    const date = daysAgo(i);
    const snap = await db.ref(`analytics/${pid}/hits/${date}`).once("value");
    if (!snap.exists()) continue;
    snap.forEach(child => {
      const h = child.key;
      const c = child.val()?.count || 0;
      byHash.set(h, (byHash.get(h) || 0) + c);
    });
  }

  const sorted = Array.from(byHash.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit);

  const results = [];
  for (const [h, count] of sorted) {
    const pathSnap = await db.ref(`analytics/${pid}/paths/${h}`).once("value");
    results.push({
      pathHash: h,
      path: pathSnap.exists() ? pathSnap.val() : "/(unknown)",
      count,
    });
  }
  return results;
}

/**
 * Sum db + api counters over the last N days.
 */
async function readUsage(pid, days) {
  const dates = [];
  for (let i = 0; i < days; i++) dates.push(daysAgo(i));

  const dbAgg = { reads: 0, writes: 0, bytesIn: 0, bytesOut: 0 };
  const apiAgg = { calls: 0, errors: 0 };

  for (const date of dates) {
    const dbSnap = await db.ref(`analytics/${pid}/db/${date}`).once("value");
    if (dbSnap.exists()) {
      const v = dbSnap.val();
      dbAgg.reads += (v.reads || 0);
      dbAgg.writes += (v.writes || 0);
      dbAgg.bytesIn += (v.bytesIn || 0);
      dbAgg.bytesOut += (v.bytesOut || 0);
    }
    const apiSnap = await db.ref(`analytics/${pid}/api/${date}`).once("value");
    if (apiSnap.exists()) {
      const v = apiSnap.val();
      apiAgg.calls += (v.calls || 0);
      apiAgg.errors += (v.errors || 0);
    }
  }

  return { db: dbAgg, api: apiAgg };
}

// =========================================================================
// HANDLERS
// =========================================================================

/**
 * POST /hit — public, wildcard CORS, called from deployed pages.
 * Body: { projectId, path, referrer? }
 *
 * Also:
 *  - maintains a daily rollup counter (analytics/{pid}/rollups/{today})
 *  - on milestone crossings, evaluates A1 (spike) + A5 (viral)
 *  - on first hit of day, evaluates A2 (first-after-deploy)
 *  - tracks referrer floods (A3) and sampled bot floods (A4)
 *
 * 🆕 All evaluate* calls are now AWAITED. They only fire on milestone
 * thresholds, so the hot path (99% of hits) still returns fast.
 */
async function handleHit(req, res, reqId) {
  const ip = getClientIp(req);

  // Per-IP limit
  if (!(await enforceRate(res, "hit", `ip_${hashIp(ip)}`))) return;

  const { projectId, path: rawPath, referrer: rawReferrer } = req.body || {};
  if (!projectId || typeof projectId !== "string") {
    return res.status(400).json({ success: false, error: "Missing projectId" });
  }
  if (typeof rawPath !== "string" || rawPath.length > 500) {
    return res.status(400).json({ success: false, error: "Invalid path" });
  }

  // ── Bot filter (sampled counter so A4 can fire) ──
  if (isBot(req)) {
    // Sample 1-in-10 to keep writes bounded even under a flood.
    if (Math.random() < 0.1) {
      const bucket = Math.floor(Date.now() / (10 * 60 * 1000)); // 10-min bucket
      const botRef = db.ref(`analytics/${projectId}/bots/${bucket}`);
      try {
        // Circuit breaker: stop writing once a bucket already crossed the alert point.
        const snap = await botRef.once("value");
        const cur = snap.exists() ? (snap.val()?.count || 0) : 0;
        if (cur < 40) {
          const result = await botRef.transaction(c => {
            const v = c || { count: 0 };
            v.count = (v.count || 0) + 1;
            v.lastTs = Date.now();
            return v;
          });
          const after = result?.snapshot?.val()?.count || 0;
          // 🆕 Await — evaluateBotFlood only fires at count === 20.
          if (after === 20) {
            await evaluateBotFlood(projectId, bucket, after);
          }
        }
      } catch (err) {
        log("analytics.bot_rollup_failed", { reqId, projectId, message: err.message });
      }
    }
    return res.status(200).json({ success: true, skipped: "bot" });
  }

  // Confirm project exists
  const existsSnap = await db.ref(`projects/${projectId}/ownerId`).once("value");
  if (!existsSnap.exists()) {
    return res.status(404).json({ success: false, error: "Project not found" });
  }

  // Per-project limit
  if (!(await enforceRate(res, "hitByProject", `pid_${projectId}`))) return;

  const h = pathHash(rawPath);
  const today = dayString();

  // ── Primary hit counter ──
  try {
    await db.ref(`analytics/${projectId}/hits/${today}/${h}`).transaction(cur => {
      const c = cur || { count: 0, lastTs: 0 };
      c.count = (c.count || 0) + 1;
      c.lastTs = Date.now();
      return c;
    });
  } catch (err) {
    log("analytics.hit_increment_failed", { reqId, projectId, message: err.message });
    return res.status(500).json({ success: false, error: "Increment failed" });
  }

  // Idempotent path mapping
  try {
    const pathSnap = await db.ref(`analytics/${projectId}/paths/${h}`).once("value");
    if (!pathSnap.exists()) {
      await db.ref(`analytics/${projectId}/paths/${h}`).set(rawPath);
    }
  } catch (err) {
    log("analytics.hit_path_write_failed", { reqId, projectId, message: err.message });
  }

  // ── Daily rollup + milestone detection ──
  let todayCount = 0;
  let milestoneCrossed = null;
  try {
    const rollupRef = db.ref(`analytics/${projectId}/rollups/${today}`);
    const tx = await rollupRef.transaction(cur => {
      const c = cur || { count: 0, lastMilestone: 0, lastTs: 0 };
      const prev = c.count || 0;
      c.count = prev + 1;
      c.lastTs = Date.now();
      const next = SPIKE_MILESTONES.find(
        m => m > (c.lastMilestone || 0) && c.count >= m
      );
      if (next) {
        c.lastMilestone = next;
      }
      return c;
    });
    if (tx.committed && tx.snapshot.exists()) {
      const v = tx.snapshot.val();
      todayCount = v.count || 0;
      const justCrossed = SPIKE_MILESTONES.find(m => m === todayCount);
      if (justCrossed) milestoneCrossed = justCrossed;
    }
  } catch (err) {
    log("analytics.rollup_failed", { reqId, projectId, message: err.message });
  }

  // 🆕 AWAITED — only fires on milestone hits (rare), so hot path stays fast.
  if (milestoneCrossed) {
    try { await evaluateTrafficSpike(projectId, todayCount, milestoneCrossed); } catch {}
  }
  if (todayCount === 1) {
    try { await evaluateFirstHitAfterDeploy(projectId, todayCount); } catch {}
  }

  // ── A3 — Referrer flood tracking ──
  const referrer = typeof rawReferrer === "string" ? rawReferrer.slice(0, 200) : "";
  if (referrer) {
    try {
      const rh = crypto.createHash("sha256").update(referrer).digest("hex").slice(0, 8);
      const hour = new Date().toISOString().slice(0, 13); // YYYY-MM-DDTHH
      const refRef = db.ref(`analytics/${projectId}/refRollups/${hour}/${rh}`);
      const tx = await refRef.transaction(cur => {
        const c = cur || { count: 0, sample: referrer };
        c.count = (c.count || 0) + 1;
        c.sample = c.sample || referrer;
        c.lastTs = Date.now();
        return c;
      });
      if (tx.committed && tx.snapshot.exists()) {
        const newCount = tx.snapshot.val()?.count || 0;
        // 🆕 AWAITED — only fires at exactly 500.
        if (newCount === 500) {
          await evaluateReferrerFlood(projectId, hour, referrer, newCount);
        }
      }
    } catch (err) {
      log("analytics.ref_rollup_failed", { reqId, projectId, message: err.message });
    }
  }

  return res.status(200).json({ success: true });
}

/**
 * GET /project?pid — viewer+ role required.
 * Returns aggregate stats: 7-day trend, top pages, DB/API usage, total views.
 */
async function handleProject(req, res, reqId) {
  const pid = String(req.query?.pid || "").trim();
  if (!pid) return res.status(400).json({ success: false, error: "Missing pid" });

  const user = await requireAuth(req, res);
  if (!user) return;
  if (!(await enforceRate(res, "projectQuery", `uid_${user.uid}`))) return;

  const access = await requireProjectRole(req, res, pid, "viewer");
  if (!access) return;

  const [trend7, topPages, usage, total] = await Promise.all([
    readDailyTrend(pid, 7),
    readTopPages(pid, 7, 10),
    readUsage(pid, 7),
    readTotalHits(pid),
  ]);

  return res.status(200).json({
    success: true,
    today: trend7[trend7.length - 1]?.count || 0,
    trend7,
    total,
    topPages,
    db: usage.db,
    api: usage.api,
  });
}

/**
 * GET /profile?uid — self-only. Profile view stats.
 */
async function handleProfile(req, res, reqId) {
  const uid = String(req.query?.uid || "").trim();
  if (!uid) return res.status(400).json({ success: false, error: "Missing uid" });

  const user = await requireAuth(req, res);
  if (!user) return;
  if (!(await enforceRate(res, "profileQuery", `uid_${user.uid}`))) return;

  if (user.uid !== uid) {
    return res.status(403).json({ success: false, error: "Forbidden" });
  }

  // Last 30 days of profile views
  const dayBuckets = [];
  let total = 0;
  let last7 = 0;
  let last30 = 0;

  for (let i = 29; i >= 0; i--) {
    const date = daysAgo(i);
    const snap = await db.ref(`analytics/${uid}/profile/views/${date}`).once("value");
    let count = 0;
    if (snap.exists()) {
      snap.forEach(() => { count++; });
    }
    dayBuckets.push({ date, count });
    total += count;
    last30 += count;
    if (i < 7) last7 += count;
  }

  return res.status(200).json({
    success: true,
    total,
    last7,
    last30,
    trend30: dayBuckets,
  });
}

/**
 * GET /activity?pid — viewer+ role required.
 * Returns recent activity events from analytics/{pid}/activity.
 */
async function handleActivity(req, res, reqId) {
  const pid = String(req.query?.pid || "").trim();
  if (!pid) return res.status(400).json({ success: false, error: "Missing pid" });

  const user = await requireAuth(req, res);
  if (!user) return;
  if (!(await enforceRate(res, "activityQuery", `uid_${user.uid}`))) return;

  const access = await requireProjectRole(req, res, pid, "viewer");
  if (!access) return;

  const limit = Math.min(Math.max(parseInt(req.query?.limit, 10) || 50, 1), 200);
  const offset = Math.max(parseInt(req.query?.offset, 10) || 0, 0);
  const typeFilter = String(req.query?.type || "all");

  const snap = await db.ref(`analytics/${pid}/activity`).once("value");
  const events = [];
  if (snap.exists()) {
    snap.forEach(child => {
      const v = child.val();
      if (typeFilter !== "all" && v.type !== typeFilter) return;
      events.push({ id: child.key, ...v });
    });
  }
  events.sort((a, b) => (b.ts || 0) - (a.ts || 0));
  const slice = events.slice(offset, offset + limit);

  return res.status(200).json({
    success: true,
    activity: slice,
    total: events.length,
    hasMore: offset + limit < events.length,
  });
}

// =========================================================================
// ROUTER
// =========================================================================

export default async function handler(req, res) {
  const reqId = newReqId();
  res.setHeader("X-Request-Id", reqId);

  // CORS — wildcard (playbook §11: "CORS: Allow *")
  // Trackers on deployed pages must be able to post from any domain.
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.status(204).end();

  const action = String(req.query?.action || req.body?.action || "").trim();
  const method = req.method;

  try {
    if (method === "POST" && action === "hit")      return await handleHit(req, res, reqId);
    if (method === "GET"  && action === "project")  return await handleProject(req, res, reqId);
    if (method === "GET"  && action === "profile")  return await handleProfile(req, res, reqId);
    if (method === "GET"  && action === "activity") return await handleActivity(req, res, reqId);

    return res.status(404).json({ success: false, error: `Unknown action: ${action || "(none)"}` });
  } catch (err) {
    log("analytics.unhandled_error", { reqId, action, method, message: err.message, stack: err.stack });
    return res.status(500).json({ success: false, error: "Internal error", reqId });
  }
}

export const config = { runtime: "nodejs" };