
"use strict";

// ============================================================
// FOLIO — PRODUCTION SERVICE WORKER
// Offline-first shell, CDN assets, FCM and Device File Handling
// ============================================================
//
// Build-time placeholders:
// __FOLIO_SW_VERSION__
// __FOLIO_SW_BUILT_AT__
//
// Features:
// - Atomic installation and critical-resource verification
// - Offline-first navigation and asset caching
// - Optional CDN caching
// - Firebase Cloud Messaging
// - Push notifications
// - Android Web Share Target file reception
// - Persistent IndexedDB file inbox
// - Multiple-file reception
// - File inbox management and diagnostics
//
// IMPORTANT:
// - CRITICAL_FILES must contain same-origin resources only.
// - External CDN failures never block installation.
// - Previous caches are preserved until successful activation.
// - File inbox uses a separate database from Folio's main DB.
// - File reception does not execute received content.
// ============================================================


// ============================================================
// CONFIGURATION
// ============================================================

const CACHE_VERSION = "__FOLIO_SW_VERSION__";
const CACHE_BUILT_AT = Number("__FOLIO_SW_BUILT_AT__");

const CACHE_PREFIX = "folio-shell-";
const CACHE_NAME = `${CACHE_PREFIX}${CACHE_VERSION}`;

const CACHE_META_KEY = "/__folio_internal__/install-complete";

const NAVIGATION_TIMEOUT = 5000;
const ASSET_TIMEOUT = 12000;

const MAX_PARALLEL_INSTALLS = 6;


// ============================================================
// FILE RECEIVER CONFIGURATION
// ============================================================

const FILE_RECEIVER_PATH = "/file-receiver";

const FILE_INBOX_DB = "folio-file-inbox";
const FILE_INBOX_VERSION = 1;
const FILE_INBOX_STORE = "files";

const FILE_INBOX_LIMITS = {
  maxFiles: 10,
  maxFileSize: 20 * 1024 * 1024,
  maxTotalSize: 50 * 1024 * 1024,
};

const SUPPORTED_FILE_EXTENSIONS = new Set([
  "html", "htm",
  "css",
  "js", "mjs", "cjs",
  "json",
  "md", "markdown",
  "txt",
  "xml",
  "svg",
  "yaml", "yml",
  "toml",
  "csv",
  "ts", "tsx",
  "jsx",
  "scss", "less",
  "php",
  "py",
  "sql",
  "sh",
]);


// ============================================================
// LOGGING
// ============================================================

const SW_DEBUG =
  self.location.hostname === "localhost" ||
  self.location.hostname === "127.0.0.1" ||
  self.location.search.includes("sw-debug=1");

function log(...args) {
  console.log("[Folio SW]", ...args);
}

function logDetail(...args) {
  if (SW_DEBUG) {
    console.log("[Folio SW]", ...args);
  }
}

function warn(...args) {
  console.warn("[Folio SW]", ...args);
}

function error(...args) {
  console.error("[Folio SW]", ...args);
}


// ============================================================
// LIVE-SITE DETECTION
// ============================================================

const LIVE_SITE_PATH_RE = /^\/[^/]+\/project\/[^/]+(\/|$)/;

function isLiveSiteRequest(url) {
  try {
    if (url.origin !== self.location.origin) return false;

    if (LIVE_SITE_PATH_RE.test(url.pathname)) return true;

    if (url.searchParams.has("from")) return true;

    return false;
  } catch {
    return false;
  }
}


// ============================================================
// ALLOWED EXTERNAL HOSTS
// ============================================================

const CDN_HOSTS = new Set([
  "deno.land",
  "esm.sh",
  "fonts.googleapis.com",
  "fonts.gstatic.com",
  "www.gstatic.com",
]);


// ============================================================
// PRE-CACHE FILES
// ============================================================

const CODEMIRROR_FILES = [
  "https://deno.land/x/codemirror_esm@v6.0.1/esm/codemirror/dist/index.js",
  "https://deno.land/x/codemirror_esm@v6.0.1/esm/view/dist/index.js",
  "https://deno.land/x/codemirror_esm@v6.0.1/esm/state/dist/index.js",
  "https://deno.land/x/codemirror_esm@v6.0.1/esm/commands/dist/index.js",
  "https://deno.land/x/codemirror_esm@v6.0.1/esm/search/dist/index.js",
  "https://deno.land/x/codemirror_esm@v6.0.1/esm/lint/dist/index.js",
  "https://deno.land/x/codemirror_esm@v6.0.1/esm/merge/dist/index.js",
  "https://deno.land/x/codemirror_esm@v6.0.1/esm/language/dist/index.js",
  "https://deno.land/x/codemirror_esm@v6.0.1/esm/theme-one-dark/dist/index.js",
  "https://deno.land/x/codemirror_esm@v6.0.1/esm/lang-html/dist/index.js",
  "https://deno.land/x/codemirror_esm@v6.0.1/esm/lang-css/dist/index.js",
  "https://deno.land/x/codemirror_esm@v6.0.1/esm/lang-javascript/dist/index.js",
  "https://deno.land/x/codemirror_esm@v6.0.1/esm/lang-json/dist/index.js",
  "https://deno.land/x/codemirror_esm@v6.0.1/esm/lang-markdown/dist/index.js",
  "https://deno.land/x/codemirror_esm@v6.0.1/esm/lang-python/dist/index.js",
];

const CACHED_FILES = [
  "/",
  "/index.html",

  "/settings",
  "/settings.html",

  "/projects",
  "/projects.html",

  "/tools",
  "/tools.html",

  "/profile",
  "/profile.html",

  "/register",
  "/register.html",

  "/project",
  "/project.html",

  "/analytics",
  "/analytics.html",

  "/offline",
  "/offline.html",

  "/invite",
  "/invite.html",

  "/notifications",
  "/notifications.html",

  "/ai",
  "/ai.html",

  "/css/app.css",
  "/css/project.css",
  "/css/ai.css",

  "/manifest.json",

  "/icons/icon-144.png",
  "/icons/icon-192.png",
  "/icons/icon-512.png",
  "/icons/notif.png",

  "/screenshots/screenshot1.png",
  "/screenshots/screenshot2.png",
  "/screenshots/screenshot3.png",
  "/screenshots/screenshot4.png",
  "/screenshots/screenshot5.png",
  "/screenshots/screenshot6.png",

  "/install.js",
  "/update.js",
  "/fcm-client.js",
  "/notifications.js",
  "/js/ai.js",
  "/js/create-project.js",
  "/js/preview.js",

  "/vendor/firebase/firebase-app-compat.js",
  "/vendor/firebase/firebase-messaging-compat.js",

  ...CODEMIRROR_FILES,
];


// ============================================================
// CRITICAL RESOURCES
// ============================================================

const CRITICAL_FILES = new Set([
  "/",
  "/index.html",
  "/offline.html",
  "/css/app.css",
  "/manifest.json",
  "/install.js",
  "/update.js",
]);


// ============================================================
// BYPASS RULES
// ============================================================

function shouldBypass(url, request) {
  if (request.method !== "GET") return true;

  if (request.headers.get("range")) return true;

  if (url.protocol === "chrome-extension:") return true;

  if (isLiveSiteRequest(url)) return true;

  if (url.origin !== self.location.origin) {
    if (!CDN_HOSTS.has(url.hostname)) {
      logDetail("Bypassing non-allowed external:", url.href);
      return true;
    }
  }

  if (url.pathname.startsWith("/api/")) return true;

  if (
    url.pathname.startsWith("/firebase-cloud-messaging-push-scope/") ||
    url.pathname === "/firebase-messaging-sw.js" ||
    url.pathname.endsWith("/firebase-messaging-sw.js") ||
    url.pathname.includes("/__/firebase/")
  ) {
    return true;
  }

  return false;
}


// ============================================================
// CONTENT TYPE VALIDATION
// ============================================================

function expectedContentTypesFor(url) {
  let pathname;

  try {
    pathname = new URL(url, self.location.origin).pathname;
  } catch {
    return null;
  }

  const match = pathname.match(/\.([a-z0-9]+)$/i);
  const ext = match ? match[1].toLowerCase() : "";

  if (ext === "js" || ext === "mjs") {
    return ["javascript", "ecmascript"];
  }

  if (ext === "css") return ["text/css"];

  if (ext === "json" || ext === "webmanifest") {
    return ["json", "manifest"];
  }

  if (ext === "png") return ["image/png"];

  if (ext === "jpg" || ext === "jpeg") return ["image/jpeg"];

  if (ext === "webp") return ["image/webp"];

  if (ext === "svg") return ["image/svg+xml"];

  if (ext === "ico") {
    return ["image/x-icon", "image/vnd.microsoft.icon"];
  }

  if (ext === "html") return ["text/html"];

  if (ext === "txt") return ["text/plain"];

  if (ext === "xml") return ["xml"];

  if (!ext) return ["text/html"];

  return null;
}

function contentTypeOk(url, response) {
  const expected = expectedContentTypesFor(url);

  if (!expected) return true;

  const actual = (
    response.headers.get("content-type") || ""
  ).toLowerCase();

  return expected.some((type) => actual.includes(type));
}


// ============================================================
// RESPONSE VALIDATION
// ============================================================

function responseIsCacheable(url, response) {
  if (!response) return false;
  if (!response.ok) return false;
  if (response.type === "opaque") return false;
  if (!contentTypeOk(url, response)) return false;
  if (response.status === 206) return false;

  return true;
}


// ============================================================
// CACHE HELPERS
// ============================================================

async function getAppCache() {
  return caches.open(CACHE_NAME);
}

function cacheRequestFor(url) {
  return new Request(
    url instanceof Request ? url.url : url,
    {
      method: "GET",
      credentials: "omit",
    }
  );
}

async function putInCache(cache, request, response) {
  const key = request.url || request;

  if (!responseIsCacheable(key, response)) {
    logDetail("Refusing to cache:", key);
    return false;
  }

  try {
    await cache.put(
      cacheRequestFor(request),
      response.clone()
    );

    return true;
  } catch (err) {
    warn("Cache write failed:", key, err.message);
    return false;
  }
}

async function matchCached(cache, request) {
  try {
    return await cache.match(cacheRequestFor(request)) || null;
  } catch (err) {
    warn("Cache match failed:", err.message);
    return null;
  }
}


// ============================================================
// INSTALL FETCH
// ============================================================

async function fetchInstallResource(path) {
  const external =
    new URL(path, self.location.origin).origin !==
    self.location.origin;

  const controller = new AbortController();

  const timer = setTimeout(() => {
    controller.abort();
  }, ASSET_TIMEOUT);

  try {
    return await fetch(path, {
      method: "GET",
      cache: "no-store",
      credentials: external ? "omit" : "same-origin",
      mode: external ? "cors" : "same-origin",
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}


// ============================================================
// INSTALL WORKER POOL
// ============================================================

async function runInstallPool(items, concurrency, handler) {
  let index = 0;

  const workers = Array.from(
    { length: Math.min(concurrency, items.length) },
    async () => {
      while (true) {
        const current = index++;

        if (current >= items.length) return;

        await handler(items[current]);
      }
    }
  );

  await Promise.all(workers);
}


// ============================================================
// DEVICE FILE INBOX — DATABASE
// ============================================================

function openFileInboxDB() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(
      FILE_INBOX_DB,
      FILE_INBOX_VERSION
    );

    request.onupgradeneeded = () => {
      const db = request.result;

      if (!db.objectStoreNames.contains(FILE_INBOX_STORE)) {
        const store = db.createObjectStore(
          FILE_INBOX_STORE,
          { keyPath: "id" }
        );

        store.createIndex(
          "createdAt",
          "createdAt",
          { unique: false }
        );

        store.createIndex(
          "status",
          "status",
          { unique: false }
        );
      }
    };

    request.onsuccess = () => {
      resolve(request.result);
    };

    request.onerror = () => {
      reject(
        request.error ||
        new Error("File inbox database failed")
      );
    };

    request.onblocked = () => {
      reject(new Error("File inbox database upgrade blocked"));
    };
  });
}


// ============================================================
// DEVICE FILE HELPERS
// ============================================================

function createFileId() {
  if (self.crypto?.randomUUID) {
    return self.crypto.randomUUID();
  }

  return (
    Date.now().toString(36) +
    "-" +
    Math.random().toString(36).slice(2) +
    "-" +
    Math.random().toString(36).slice(2)
  );
}

function getFileExtension(name) {
  const parts = String(name || "").split(".");

  return parts.length > 1
    ? parts.pop().toLowerCase()
    : "";
}

function isSupportedDeviceFile(file) {
  if (!file || typeof file.name !== "string") {
    return false;
  }

  return SUPPORTED_FILE_EXTENSIONS.has(
    getFileExtension(file.name)
  );
}


// ============================================================
// SAVE INCOMING FILES
// ============================================================

async function saveIncomingFiles(records) {
  const db = await openFileInboxDB();

  try {
    return await new Promise((resolve, reject) => {
      const transaction = db.transaction(
        FILE_INBOX_STORE,
        "readwrite"
      );

      const store = transaction.objectStore(
        FILE_INBOX_STORE
      );

      for (const record of records) {
        store.put(record);
      }

      transaction.oncomplete = () => resolve(true);

      transaction.onerror = () => {
        reject(
          transaction.error ||
          new Error("File storage failed")
        );
      };

      transaction.onabort = () => {
        reject(
          transaction.error ||
          new Error("File storage aborted")
        );
      };
    });
  } finally {
    db.close();
  }
}


// ============================================================
// RECEIVE SHARED FILES
// ============================================================

async function receiveSharedFiles(request) {
  const contentType = (
    request.headers.get("content-type") || ""
  ).toLowerCase();

  if (!contentType.includes("multipart/form-data")) {
    throw new Error("Invalid file upload content type.");
  }

  const formData = await request.formData();

  const entries = formData.getAll("files");

  const candidates = entries.filter(
    (item) =>
      item &&
      typeof item.name === "string" &&
      typeof item.size === "number" &&
      typeof item.arrayBuffer === "function"
  );

  if (!candidates.length) {
    throw new Error("No files were received.");
  }

  if (candidates.length > FILE_INBOX_LIMITS.maxFiles) {
    throw new Error(
      `Maximum ${FILE_INBOX_LIMITS.maxFiles} files allowed per share.`
    );
  }

  const records = [];
  let totalSize = 0;

  for (const file of candidates) {
    if (!isSupportedDeviceFile(file)) {
      logDetail("Unsupported shared file skipped:", file.name);
      continue;
    }

    if (file.size > FILE_INBOX_LIMITS.maxFileSize) {
      throw new Error(`File too large: ${file.name}`);
    }

    totalSize += file.size;

    if (totalSize > FILE_INBOX_LIMITS.maxTotalSize) {
      throw new Error("Shared files exceed the total size limit.");
    }

    records.push({
      id: createFileId(),

      name: file.name,
      extension: getFileExtension(file.name),
      mimeType: file.type || "application/octet-stream",
      size: file.size,
      lastModified: file.lastModified || Date.now(),

      blob: file,

      source: "android-share",
      status: "pending",

      createdAt: Date.now(),

      metadata: {
        title: String(formData.get("title") || ""),
        text: String(formData.get("text") || ""),
        url: String(formData.get("url") || ""),
      },
    });
  }

  if (!records.length) {
    throw new Error("No supported file types were found.");
  }

  await saveIncomingFiles(records);

  log("Device files received:", {
    count: records.length,
    names: records.map((file) => file.name),
    totalSize,
  });

  return {
    count: records.length,
    files: records.map((file) => ({
      id: file.id,
      name: file.name,
      size: file.size,
    })),
  };
}


// ============================================================
// FILE INBOX — READ
// ============================================================

async function getFileInbox() {
  const db = await openFileInboxDB();

  try {
    return await new Promise((resolve, reject) => {
      const transaction = db.transaction(
        FILE_INBOX_STORE,
        "readonly"
      );

      const request = transaction
        .objectStore(FILE_INBOX_STORE)
        .getAll();

      request.onsuccess = () => {
        resolve(
          (request.result || []).sort(
            (a, b) => b.createdAt - a.createdAt
          )
        );
      };

      request.onerror = () => {
        reject(request.error);
      };
    });
  } finally {
    db.close();
  }
}


// ============================================================
// FILE INBOX — DELETE SELECTED
// ============================================================

async function deleteInboxFiles(ids) {
  if (!Array.isArray(ids) || !ids.length) {
    return 0;
  }

  const db = await openFileInboxDB();

  try {
    return await new Promise((resolve, reject) => {
      const transaction = db.transaction(
        FILE_INBOX_STORE,
        "readwrite"
      );

      const store = transaction.objectStore(
        FILE_INBOX_STORE
      );

      let deleted = 0;

      ids.forEach((id) => {
        if (typeof id !== "string") return;

        store.delete(id);
        deleted++;
      });

      transaction.oncomplete = () => resolve(deleted);

      transaction.onerror = () => {
        reject(transaction.error);
      };

      transaction.onabort = () => {
        reject(transaction.error);
      };
    });
  } finally {
    db.close();
  }
}


// ============================================================
// FILE INBOX — CLEAR
// ============================================================

async function clearFileInbox() {
  const db = await openFileInboxDB();

  try {
    return await new Promise((resolve, reject) => {
      const transaction = db.transaction(
        FILE_INBOX_STORE,
        "readwrite"
      );

      transaction.objectStore(FILE_INBOX_STORE).clear();

      transaction.oncomplete = () => resolve(true);

      transaction.onerror = () => {
        reject(transaction.error);
      };

      transaction.onabort = () => {
        reject(transaction.error);
      };
    });
  } finally {
    db.close();
  }
}


// ============================================================
// FILE RECEIVER REDIRECT
// ============================================================

function fileReceiverRedirect(params = {}) {
  const target = new URL("/", self.location.origin);

  for (const [key, value] of Object.entries(params)) {
    target.searchParams.set(key, String(value));
  }

  return Response.redirect(target.toString(), 303);
}


// ============================================================
// FILE RECEIVER REQUEST HANDLER
// ============================================================

async function handleFileReceiver(request) {
  try {
    if (request.method !== "POST") {
      return fileReceiverRedirect({
        "folio-file-error": "invalid-method",
      });
    }

    const result = await receiveSharedFiles(request);

    return fileReceiverRedirect({
      "folio-inbox": "1",
      "folio-file-count": result.count,
    });

  } catch (err) {
    error("Device file reception failed:", err);

    return fileReceiverRedirect({
      "folio-file-error": "receive-failed",
    });
  }
}


// ============================================================
// INSTALL
// ============================================================

self.addEventListener("install", (event) => {
  log(`Installing version ${CACHE_VERSION}`, {
    totalResources: CACHED_FILES.length,
    criticalResources: CRITICAL_FILES.size,
    cacheName: CACHE_NAME,
  });

  event.waitUntil(
    (async () => {
      const cache = await getAppCache();

      const report = {
        version: CACHE_VERSION,
        successful: 0,
        skipped: 0,
        failed: 0,
        criticalFailed: [],
        optionalFailed: [],
        total: CACHED_FILES.length,
      };

      await runInstallPool(
        CACHED_FILES,
        MAX_PARALLEL_INSTALLS,
        async (path) => {
          try {
            const existing = await cache.match(path);

            if (
              existing &&
              existing.ok &&
              contentTypeOk(path, existing)
            ) {
              report.successful++;
              report.skipped++;

              logDetail("Cache hit:", path);
              return;
            }

            const response = await fetchInstallResource(path);

            if (!responseIsCacheable(path, response)) {
              throw new Error(
                `Invalid response: ${response.status} ` +
                `(${response.headers.get("content-type") || "no content-type"})`
              );
            }

            const saved = await putInCache(
              cache,
              path,
              response
            );

            if (!saved) {
              throw new Error("Cache storage rejected response");
            }

            report.successful++;

            logDetail("Cached:", path);

          } catch (err) {
            report.failed++;

            const entry = {
              path,
              error: err.message,
              isExternal:
                new URL(path, self.location.origin).origin !==
                self.location.origin,
            };

            if (CRITICAL_FILES.has(path)) {
              report.criticalFailed.push(entry);

              warn(
                "CRITICAL pre-cache failed:",
                path,
                err.message
              );
            } else {
              report.optionalFailed.push(entry);

              logDetail(
                "Optional pre-cache failed:",
                path,
                err.message
              );
            }
          }
        }
      );

      log("Installation report:", {
        version: report.version,
        total: report.total,
        successful: report.successful,
        skipped: report.skipped,
        failed: report.failed,
        criticalFailed: report.criticalFailed.length,
        optionalFailed: report.optionalFailed.length,
      });

      const editorFailures = report.optionalFailed.filter(
        (f) => f.path.includes("deno.land")
      );

      if (editorFailures.length > 0) {
        warn(
          `Editor CDN assets failed to cache ` +
          `(${editorFailures.length}/${CODEMIRROR_FILES.length}). ` +
          `App shell will still work offline.`
        );

        logDetail(
          "Failed editor assets:",
          editorFailures.map((f) => f.path)
        );
      } else {
        log(
          `Editor CDN assets cached ` +
          `(${CODEMIRROR_FILES.length}/${CODEMIRROR_FILES.length}).`
        );
      }

      if (report.optionalFailed.length > 0) {
        logDetail(
          "Non-critical failures:",
          report.optionalFailed.map((f) => f.path)
        );
      }

      if (report.criticalFailed.length > 0) {
        error(
          "Installation ABORTED:",
          report.criticalFailed
        );

        throw new Error(
          "Folio installation incomplete: critical resources unavailable"
        );
      }

      const completion = new Response(
        JSON.stringify({
          version: CACHE_VERSION,
          builtAt: CACHE_BUILT_AT,
          installedAt: Date.now(),
          successful: report.successful,
          skipped: report.skipped,
          failed: report.failed,
          optionalFailed: report.optionalFailed,
          editorReady: editorFailures.length === 0,
        }),
        {
          headers: {
            "Content-Type": "application/json",
          },
        }
      );

      await cache.put(CACHE_META_KEY, completion);

      log(
        "Installation completed successfully.",
        {
          version: CACHE_VERSION,
          successful: report.successful,
          failed: report.failed,
          skipped: report.skipped,
        }
      );
    })()
  );
});


// ============================================================
// ACTIVATE
// ============================================================

self.addEventListener("activate", (event) => {
  log(`Activating ${CACHE_VERSION}`);

  event.waitUntil(
    (async () => {
      const cache = await getAppCache();

      const marker = await cache.match(CACHE_META_KEY);

      if (!marker) {
        error("Activation refused: missing installation marker.");

        throw new Error("Cannot activate incomplete Folio cache");
      }

      let metadata;

      try {
        metadata = await marker.clone().json();
      } catch {
        error("Activation refused: invalid installation metadata.");

        throw new Error("Invalid installation metadata");
      }

      if (metadata.version !== CACHE_VERSION) {
        error("Activation refused: version mismatch.");

        throw new Error("Installation version mismatch");
      }

      log("Installation marker verified:", metadata);

      const missingCritical = [];

      for (const path of CRITICAL_FILES) {
        const cached = await cache.match(path);

        if (!cached) {
          missingCritical.push(path);
        }
      }

      if (missingCritical.length > 0) {
        error(
          "Activation refused: missing critical resources.",
          missingCritical
        );

        throw new Error(
          `Critical resources missing: ${missingCritical.join(", ")}`
        );
      }

      log("Critical resources verified.");

      const keys = await caches.keys();

      const staleCaches = keys.filter(
        (key) =>
          key.startsWith(CACHE_PREFIX) &&
          key !== CACHE_NAME
      );

      if (staleCaches.length > 0) {
        log("Deleting stale caches:", staleCaches);
      }

      await Promise.all(
        staleCaches.map((key) => caches.delete(key))
      );

      await self.clients.claim();

      log("Clients claimed.");

      const clients = await self.clients.matchAll({
        type: "window",
        includeUncontrolled: true,
      });

      log(`Notifying ${clients.length} client(s).`);

      clients.forEach((client) => {
        try {
          client.postMessage({
            type: "SW_ACTIVATED",
            version: CACHE_VERSION,
            builtAt: CACHE_BUILT_AT,
            timestamp: Date.now(),
            metadata,
          });
        } catch (err) {
          warn("Client notification failed:", err.message);
        }
      });

      log("Activated successfully.", {
        version: CACHE_VERSION,
        editorReady: metadata.editorReady,
      });
    })()
  );
});


// ============================================================
// FETCH HANDLER
// ============================================================

self.addEventListener("fetch", (event) => {
  const request = event.request;

  let url;

  try {
    url = new URL(request.url);
  } catch {
    return;
  }

  // IMPORTANT:
  // Share Target POST requests must be handled BEFORE
  // shouldBypass(), because normal POST requests are bypassed.

  if (
    url.origin === self.location.origin &&
    url.pathname === FILE_RECEIVER_PATH
  ) {
    event.respondWith(
      handleFileReceiver(request)
    );

    return;
  }

  if (shouldBypass(url, request)) return;

  const isNavigation =
    request.mode === "navigate" ||
    (request.headers.get("accept") || "").includes("text/html");

  if (isNavigation) {
    logDetail("Navigate:", url.pathname);

    event.respondWith(
      networkFirstNavigation(request)
    );

    return;
  }

  const updatePromise = updateAssetCache(request);

  event.waitUntil(
    updatePromise.catch(() => null)
  );

  event.respondWith(
    serveAsset(request, updatePromise)
  );
});


// ============================================================
// NAVIGATION URL NORMALIZATION
// ============================================================

function getNavigationCandidates(request) {
  const url = new URL(request.url);

  let path = url.pathname;

  if (path.length > 1) {
    path = path.replace(/\/+$/, "");
  }

  const candidates = [path];

  if (path !== "/") {
    candidates.push(path + "/");

    if (!/\.[a-z0-9]+$/i.test(path)) {
      candidates.push(path + ".html");
    }

    if (path.endsWith(".html")) {
      candidates.push(
        path.replace(/\.html$/i, "")
      );
    }
  } else {
    candidates.push("/index.html");
  }

  return [...new Set(candidates)];
}


// ============================================================
// FIND CACHED NAVIGATION
// ============================================================

async function findCachedNavigation(request) {
  const candidates = getNavigationCandidates(request);
  const cache = await getAppCache();

  for (const candidate of candidates) {
    const cached = await cache.match(
      candidate,
      { ignoreSearch: true }
    );

    if (cached) {
      logDetail("Navigation cache hit:", candidate);
      return cached;
    }
  }

  for (const candidate of candidates) {
    const cached = await caches.match(
      candidate,
      { ignoreSearch: true }
    );

    if (cached) {
      const type = (
        cached.headers.get("content-type") || ""
      ).toLowerCase();

      if (type.includes("text/html")) {
        logDetail("Older cache navigation hit:", candidate);
        return cached;
      }
    }
  }

  return null;
}


// ============================================================
// NETWORK FETCH WITH TIMEOUT
// ============================================================

async function fetchWithTimeout(request, timeout) {
  const controller = new AbortController();

  const timer = setTimeout(() => {
    controller.abort();
  }, timeout);

  try {
    return await fetch(request, {
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

async function fetchNavigation(request) {
  return fetchWithTimeout(
    request,
    NAVIGATION_TIMEOUT
  );
}


// ============================================================
// NETWORK-FIRST NAVIGATION
// ============================================================

async function networkFirstNavigation(request) {
  try {
    const response = await fetchNavigation(request);

    const contentType = (
      response.headers.get("content-type") || ""
    ).toLowerCase();

    if (
      !response.ok ||
      !contentType.includes("text/html") ||
      response.type === "opaque"
    ) {
      logDetail(
        "Navigation response invalid:",
        request.url
      );

      const cached = await findCachedNavigation(request);

      if (cached) return cached;

      return response;
    }

    const cache = await getAppCache();

    await putInCache(
      cache,
      request,
      response
    );

    return response;

  } catch (err) {
    warn(
      "Navigation network unavailable:",
      request.url,
      err.message
    );

    const cached = await findCachedNavigation(request);

    if (cached) return cached;

    return offlinePage(request);
  }
}


// ============================================================
// ASSET NETWORK FETCH
// ============================================================

async function fetchAsset(request) {
  const url = new URL(request.url);
  const external = url.origin !== self.location.origin;

  return fetchWithTimeout(
    new Request(request, {
      credentials: external ? "omit" : "same-origin",
      mode: external ? "cors" : request.mode,
    }),
    ASSET_TIMEOUT
  );
}


// ============================================================
// UPDATE ASSET CACHE
// ============================================================

function updateAssetCache(request) {
  return (async () => {
    try {
      const response = await fetchAsset(request);

      if (!responseIsCacheable(request.url, response)) {
        return null;
      }

      const url = new URL(request.url);

      const allowed =
        url.origin === self.location.origin ||
        CDN_HOSTS.has(url.hostname);

      if (!allowed) return null;

      const cache = await getAppCache();

      const saved = await putInCache(
        cache,
        request,
        response
      );

      if (saved) {
        logDetail("Asset refreshed:", url.pathname);
      }

      return saved ? response : null;

    } catch (err) {
      logDetail(
        "Asset refresh failed:",
        request.url,
        err.message
      );

      return null;
    }
  })();
}


// ============================================================
// SERVE STATIC ASSETS
// ============================================================

async function serveAsset(request, networkPromise) {
  const cache = await getAppCache();

  const cached = await matchCached(
    cache,
    request
  );

  if (cached) return cached;

  const networkResponse = await networkPromise;

  if (networkResponse) {
    return networkResponse;
  }

  const url = new URL(request.url);

  warn("Asset unavailable offline:", url.pathname);

  if (/\.(m?js)$/i.test(url.pathname)) {
    return new Response(
      "/* Folio offline: JavaScript resource unavailable */",
      {
        status: 503,
        statusText: "Offline",
        headers: {
          "Content-Type": "application/javascript; charset=utf-8",
          "Cache-Control": "no-store",
          "X-Folio-Offline": "1",
        },
      }
    );
  }

  if (/\.css$/i.test(url.pathname)) {
    return new Response(
      "/* Folio offline: stylesheet unavailable */",
      {
        status: 503,
        statusText: "Offline",
        headers: {
          "Content-Type": "text/css; charset=utf-8",
          "Cache-Control": "no-store",
          "X-Folio-Offline": "1",
        },
      }
    );
  }

  return new Response(
    "Folio resource unavailable offline.",
    {
      status: 503,
      statusText: "Offline",
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
        "Cache-Control": "no-store",
        "X-Folio-Offline": "1",
      },
    }
  );
}


// ============================================================
// OFFLINE PAGE
// ============================================================

async function offlinePage(request) {
  const cache = await getAppCache();

  const cached = await cache.match("/offline.html");

  if (cached) return cached;

  return new Response(
    `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="theme-color" content="#0a0c10">
<title>Offline — Folio</title>
<style>
:root {
  color-scheme: dark;
  font-family: Inter,system-ui,-apple-system,sans-serif;
}
* { box-sizing: border-box; }
body {
  background: #0a0c10;
  color: #e8ecf1;
  margin: 0;
  min-height: 100vh;
  display: grid;
  place-items: center;
  padding: 24px;
  text-align: center;
}
main { width: 100%; max-width: 360px; }
.mark {
  width: 58px;
  height: 58px;
  display: grid;
  place-items: center;
  margin: 0 auto 24px;
  border-radius: 18px;
  background: rgba(245,158,11,.12);
  color: #F59E0B;
  font-size: 27px;
  font-weight: 800;
}
h1 {
  font-size: 23px;
  letter-spacing: -.7px;
  margin: 0 0 12px;
}
p {
  color: #a8b0bc;
  font-size: 14px;
  line-height: 1.7;
  margin: 0 auto 22px;
}
button {
  background: #F59E0B;
  color: #0a0c10;
  border: 0;
  padding: 12px 22px;
  border-radius: 10px;
  font-weight: 750;
  font-size: 14px;
}
a {
  display: inline-block;
  margin-top: 22px;
  color: #F59E0B;
  font-size: 13px;
  text-decoration: none;
  font-weight: 650;
}
.small {
  font-size: 11px;
  color: #626b78;
  margin-top: 26px;
}
</style>
</head>
<body>
<main>
  <div class="mark">F</div>
  <h1>You're offline</h1>
  <p>
    Folio can't reach the internet right now.
    Your locally saved projects remain available
    whenever their application pages have been cached.
  </p>
  <button onclick="location.reload()">Try again</button>
  <br>
  <a href="/">Return to Folio</a>
  <p class="small">Folio · Code in your pocket</p>
</main>
</body>
</html>`,
    {
      status: 200,
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
      },
    }
  );
}


// ============================================================
// CACHE DIAGNOSTICS
// ============================================================

async function getCacheStatus() {
  const cache = await getAppCache();

  const resources = [];

  let cachedCount = 0;
  let missingCount = 0;

  for (const path of CACHED_FILES) {
    const response = await cache.match(
      cacheRequestFor(path)
    );

    const item = {
      url: path,
      cached: !!response,
      critical: CRITICAL_FILES.has(path),
      external:
        new URL(path, self.location.origin).origin !==
        self.location.origin,
    };

    resources.push(item);

    if (response) cachedCount++;
    else missingCount++;
  }

  const marker = await cache.match(CACHE_META_KEY);

  let metadata = null;

  if (marker) {
    try {
      metadata = await marker.json();
    } catch {}
  }

  const missingCritical = resources
    .filter((r) => !r.cached && r.critical)
    .map((r) => r.url);

  const missingEditor = resources
    .filter((r) => !r.cached && r.url.includes("deno.land"))
    .map((r) => r.url);

  let inboxCount = 0;

  try {
    const inbox = await getFileInbox();
    inboxCount = inbox.length;
  } catch (err) {
    logDetail("File inbox unavailable:", err.message);
  }

  return {
    version: CACHE_VERSION,
    builtAt: CACHE_BUILT_AT,
    cache: CACHE_NAME,

    installed: !!marker,
    metadata,

    total: resources.length,
    cached: cachedCount,
    missing: missingCount,

    missingCritical,
    missingEditor,

    editorReady: missingEditor.length === 0,

    fileInboxCount: inboxCount,

    resources,
  };
}


// ============================================================
// MESSAGE BUS
// ============================================================

self.addEventListener("message", (event) => {
  const data = event.data;

  if (!data) return;

  const type =
    typeof data === "string"
      ? data
      : data.type || data.action;

  logDetail("Message received:", type);

  switch (type) {

    // ── Update control ─────────────────────────────────────

    case "SKIP_WAITING":
    case "skipWaiting":
      log("SKIP_WAITING received.");
      self.skipWaiting();
      break;


    // ── Version ────────────────────────────────────────────

    case "GET_VERSION":
      event.ports?.[0]?.postMessage({
        version: CACHE_VERSION,
        cache: CACHE_NAME,
        builtAt: CACHE_BUILT_AT,
      });
      break;


    // ── Cache status ───────────────────────────────────────

    case "GET_CACHE_STATUS":
      event.waitUntil(
        (async () => {
          try {
            const status = await getCacheStatus();

            event.ports?.[0]?.postMessage(status);

          } catch (err) {
            error("GET_CACHE_STATUS failed:", err.message);

            event.ports?.[0]?.postMessage({
              error: err.message,
            });
          }
        })()
      );
      break;


    // ── Clear cache ────────────────────────────────────────

    case "CLEAR_CACHE":
      event.waitUntil(
        (async () => {
          try {
            const keys = await caches.keys();

            const targets = keys.filter(
              (key) => key.startsWith(CACHE_PREFIX)
            );

            log("CLEAR_CACHE:", targets);

            await Promise.all(
              targets.map((key) => caches.delete(key))
            );

            event.ports?.[0]?.postMessage({
              ok: true,
            });

          } catch (err) {
            error("CLEAR_CACHE failed:", err.message);

            event.ports?.[0]?.postMessage({
              ok: false,
              error: err.message,
            });
          }
        })()
      );
      break;


    // ── Sync queue ─────────────────────────────────────────

    case "CHECK_QUEUE":
      event.waitUntil(
        (async () => {
          let count = 0;

          try {
            const request = indexedDB.open("folio", 3);

            const connection = await new Promise(
              (resolve, reject) => {
                request.onsuccess = () => {
                  resolve(request.result);
                };

                request.onerror = () => {
                  reject(request.error);
                };

                request.onblocked = () => {
                  reject(new Error("IDB blocked"));
                };
              }
            );

            try {
              if (
                connection.objectStoreNames.contains("syncQueue")
              ) {
                count = await new Promise((resolve) => {
                  try {
                    const transaction = connection.transaction(
                      "syncQueue",
                      "readonly"
                    );

                    const result = transaction
                      .objectStore("syncQueue")
                      .getAll();

                    result.onsuccess = () => {
                      resolve(result.result?.length || 0);
                    };

                    result.onerror = () => resolve(0);

                  } catch {
                    resolve(0);
                  }
                });
              }
            } finally {
              connection.close();
            }

          } catch (err) {
            warn("CHECK_QUEUE failed:", err.message);
          }

          event.ports?.[0]?.postMessage({ count });
        })()
      );
      break;


    // ── Notification state ─────────────────────────────────

    case "GET_NOTIFICATION_STATE":
      event.waitUntil(
        (async () => {
          let permission = "default";

          try {
            if (typeof Notification !== "undefined") {
              permission = Notification.permission;
            }
          } catch {}

          event.ports?.[0]?.postMessage({
            permission,
            version: CACHE_VERSION,
          });
        })()
      );
      break;


    // ── Close notification ─────────────────────────────────

    case "CLOSE_NOTIFICATION":
      event.waitUntil(
        (async () => {
          try {
            const tag = data.tag || data.notificationId;

            if (!tag) {
              event.ports?.[0]?.postMessage({
                ok: false,
              });

              return;
            }

            const notifications =
              await self.registration.getNotifications({ tag });

            notifications.forEach((n) => n.close());

            event.ports?.[0]?.postMessage({
              ok: true,
              closed: notifications.length,
            });

          } catch {
            event.ports?.[0]?.postMessage({
              ok: false,
            });
          }
        })()
      );
      break;


    // ── List notifications ─────────────────────────────────

    case "LIST_ACTIVE_NOTIFICATIONS":
      event.waitUntil(
        (async () => {
          try {
            const notifications =
              await self.registration.getNotifications();

            event.ports?.[0]?.postMessage({
              notifications: notifications.map((n) => ({
                title: n.title,
                body: n.body,
                tag: n.tag,
                data: n.data || {},
              })),
            });

          } catch {
            event.ports?.[0]?.postMessage({
              notifications: [],
            });
          }
        })()
      );
      break;


    // ── Test notification ──────────────────────────────────

    case "TEST_NOTIFICATION":
      event.waitUntil(
        (async () => {
          try {
            await self.registration.showNotification(
              "Folio test",
              {
                body: "This is a test notification from the service worker.",
                icon: "/icons/notif.png",
                badge: "/icons/icon-144.png",
                tag: "folio-test-" + Date.now(),

                data: {
                  url: "/notifications",
                  notificationId: "test",
                  type: "system",
                },
              }
            );

            event.ports?.[0]?.postMessage({
              ok: true,
            });

          } catch (err) {
            event.ports?.[0]?.postMessage({
              ok: false,
              error: err.message,
            });
          }
        })()
      );
      break;


    // ========================================================
    // DEVICE FILE INBOX
    // ========================================================

    // ── Get incoming files ─────────────────────────────────

    case "GET_FILE_INBOX":
      event.waitUntil(
        (async () => {
          try {
            const files = await getFileInbox();

            event.ports?.[0]?.postMessage({
              ok: true,

              files: files.map((file) => ({
                id: file.id,
                name: file.name,
                extension: file.extension,
                mimeType: file.mimeType,
                size: file.size,
                lastModified: file.lastModified,
                blob: file.blob,
                source: file.source,
                status: file.status,
                createdAt: file.createdAt,
                metadata: file.metadata,
              })),
            });

          } catch (err) {
            error("GET_FILE_INBOX failed:", err.message);

            event.ports?.[0]?.postMessage({
              ok: false,
              error: err.message,
            });
          }
        })()
      );
      break;


    // ── Delete consumed files ──────────────────────────────

    case "DELETE_FILE_INBOX":
      event.waitUntil(
        (async () => {
          try {
            const deleted = await deleteInboxFiles(
              data.ids || []
            );

            event.ports?.[0]?.postMessage({
              ok: true,
              deleted,
            });

          } catch (err) {
            error("DELETE_FILE_INBOX failed:", err.message);

            event.ports?.[0]?.postMessage({
              ok: false,
              error: err.message,
            });
          }
        })()
      );
      break;


    // ── Clear file inbox ───────────────────────────────────

    case "CLEAR_FILE_INBOX":
      event.waitUntil(
        (async () => {
          try {
            await clearFileInbox();

            event.ports?.[0]?.postMessage({
              ok: true,
            });

          } catch (err) {
            error("CLEAR_FILE_INBOX failed:", err.message);

            event.ports?.[0]?.postMessage({
              ok: false,
              error: err.message,
            });
          }
        })()
      );
      break;
  }
});


// ============================================================
// PUSH PAYLOAD NORMALIZATION
// ============================================================

function normalizePushPayload(raw) {
  if (!raw || typeof raw !== "object") {
    return {
      title: "Folio",
      body: "",
      icon: "/icons/notif.png",
      badge: "/icons/icon-144.png",
      image: undefined,
      tag: undefined,
      link: "/notifications",
      notificationId: "",
      type: "system",
      user_id: "",
      extra: "",
    };
  }

  const inner =
    raw.data && typeof raw.data === "object"
      ? raw.data
      : {};

  return {
    title: raw.title || inner.title || "Folio",
    body: raw.body || inner.body || "",
    icon: raw.icon || inner.icon || "/icons/notif.png",
    badge: raw.badge || inner.badge || "/icons/icon-144.png",
    image: raw.image || inner.image || undefined,

    tag:
      raw.tag ||
      inner.tag ||
      inner.notificationId ||
      "folio",

    link:
      inner.link ||
      raw.link ||
      "/notifications",

    notificationId:
      inner.notificationId ||
      raw.notificationId ||
      "",

    type:
      inner.type ||
      raw.type ||
      "system",

    user_id:
      inner.user_id ||
      raw.user_id ||
      "",

    extra:
      inner.extra ||
      raw.extra ||
      "",
  };
}


// ============================================================
// PUSH EVENT
// ============================================================

self.addEventListener("push", (event) => {
  let payload = null;

  try {
    payload = event.data
      ? event.data.json()
      : null;
  } catch {
    try {
      payload = {
        body: event.data
          ? event.data.text()
          : "",
      };
    } catch {}
  }

  if (!payload) {
    payload = {
      title: "Folio",
      body: "You have a new notification.",
    };
  }

  const notification = normalizePushPayload(payload);

  logDetail(
    "Push received:",
    notification.notificationId,
    notification.type
  );

  const options = {
    body: notification.body,
    icon: notification.icon,
    badge: notification.badge,
    image: notification.image,
    tag: notification.tag,

    renotify: false,
    requireInteraction: false,

    data: {
      url: notification.link,
      link: notification.link,
      notificationId: notification.notificationId,
      type: notification.type,
      user_id: notification.user_id,
      extra: notification.extra,
    },
  };

  event.waitUntil(
    (async () => {
      try {
        await self.registration.showNotification(
          notification.title,
          options
        );
      } catch (err) {
        warn("showNotification failed:", err);
      }

      try {
        const clients = await self.clients.matchAll({
          type: "window",
          includeUncontrolled: true,
        });

        clients.forEach((client) => {
          client.postMessage({
            type: "PUSH_RECEIVED",
            notificationId: notification.notificationId,
            notificationType: notification.type,
          });
        });

      } catch {}
    })()
  );
});


// ============================================================
// NOTIFICATION CLICK
// ============================================================

self.addEventListener("notificationclick", (event) => {
  event.notification.close();

  const data = event.notification.data || {};

  const target =
    data.url ||
    data.link ||
    "/notifications";

  event.waitUntil(
    (async () => {
      let absoluteUrl;

      try {
        absoluteUrl = new URL(
          target,
          self.location.origin
        ).toString();

      } catch {
        absoluteUrl =
          self.location.origin + "/notifications";
      }

      const parsedTarget = new URL(absoluteUrl);

      if (parsedTarget.origin !== self.location.origin) {
        absoluteUrl =
          self.location.origin + "/notifications";
      }

      const finalTarget = new URL(absoluteUrl);

      if (isLiveSiteRequest(finalTarget)) {
        await self.clients.openWindow(absoluteUrl);
        return;
      }

      const targetPath =
        finalTarget.pathname + finalTarget.search;

      const clients = await self.clients.matchAll({
        type: "window",
        includeUncontrolled: true,
      });

      // Exact matching page.
      for (const client of clients) {
        try {
          const clientUrl = new URL(client.url);

          if (
            clientUrl.origin === self.location.origin &&
            clientUrl.pathname + clientUrl.search === targetPath
          ) {
            await client.focus();

            client.postMessage({
              type: "NOTIFICATION_CLICKED",
              notificationId: data.notificationId || "",
              url: absoluteUrl,
            });

            return;
          }
        } catch {}
      }

      // Reuse existing Folio window.
      for (const client of clients) {
        try {
          const clientUrl = new URL(client.url);

          if (clientUrl.origin === self.location.origin) {
            await client.focus();

            try {
              client.postMessage({
                type: "NOTIFICATION_CLICKED",
                notificationId: data.notificationId || "",
                url: absoluteUrl,
              });
            } catch {}

            if ("navigate" in client) {
              try {
                await client.navigate(absoluteUrl);
                return;
              } catch {}
            }

            break;
          }
        } catch {}
      }

      await self.clients.openWindow(absoluteUrl);
    })()
  );
});


// ============================================================
// NOTIFICATION CLOSE
// ============================================================

self.addEventListener("notificationclose", (event) => {
  try {
    const data = event.notification.data || {};

    self.clients
      .matchAll({
        type: "window",
        includeUncontrolled: true,
      })
      .then((clients) => {
        clients.forEach((client) => {
          client.postMessage({
            type: "NOTIFICATION_CLOSED",
            notificationId: data.notificationId || "",
          });
        });
      });

  } catch {}
});


// ============================================================
// PUSH SUBSCRIPTION CHANGE
// ============================================================

self.addEventListener("pushsubscriptionchange", (event) => {
  event.waitUntil(
    (async () => {
      try {
        const oldSubscription = event.oldSubscription;

        const newSubscription =
          event.newSubscription ||
          (
            oldSubscription
              ? await self.registration.pushManager.subscribe(
                  oldSubscription.options
                )
              : null
          );

        if (!newSubscription) return;

        log("Push subscription changed.");

        const clients = await self.clients.matchAll({
          type: "window",
          includeUncontrolled: true,
        });

        await Promise.allSettled(
          clients.map((client) => {
            try {
              client.postMessage({
                type: "PUSH_SUBSCRIPTION_CHANGED",
                subscription: newSubscription.toJSON(),
              });
            } catch {}
          })
        );

      } catch (err) {
        warn("pushsubscriptionchange failed:", err);
      }
    })()
  );
});


// ============================================================
// MESSAGE ERROR
// ============================================================

self.addEventListener("messageerror", () => {
  warn("Message serialization error");
});


// ============================================================
// STARTUP
// ============================================================

log(`Loaded ${CACHE_VERSION}`, {
  builtAt: CACHE_BUILT_AT,
  cacheName: CACHE_NAME,
  criticalCount: CRITICAL_FILES.size,
  totalCount: CACHED_FILES.length,
  fileReceiver: FILE_RECEIVER_PATH,
  fileInboxDatabase: FILE_INBOX_DB,
  debugMode: SW_DEBUG,
});
