Folio — Complete Developer Documentation

Version: 2.0
Last updated: November 2026

This is the definitive reference for building on Folio. It covers the platform, hosting model, private API runtime, database, secrets, allowed hosts, authentication patterns, deployment, debugging, and worked examples — everything you need to ship a full app.

---

Table of Contents

1. What Folio Is
2. Architecture Overview
3. Hosting Model
4. Project Structure
5. The Private API Runtime
6. The Request Object (REQ)
7. The Environment Object (ENV)
8. The Files Object (FILES)
9. Returning Responses
10. The Database API
11. Secrets Management
12. Allowed Hosts & External APIs
13. Authentication Patterns
14. The Chromium Sandbox
15. Deployment Lifecycle
16. System Routes
17. Rate Limiting
18. Logging & Observability
19. Error Handling
20. Building a Full App — Worked Example
21. Frontend Integration
22. Environment Variables
23. Debugging Playbook
24. Limits Reference
25. Security Model
26. Best Practices
27. Troubleshooting Reference

---

1. What Folio Is

Folio is a browser-based development environment for building, deploying, and hosting full-stack web apps — including:

· Static frontend — HTML, CSS, JavaScript files served from a URL
· Server-side backend — JavaScript in api/*.js files, executed in an isolated Chromium sandbox on every request
· A hosted JSON database — a per-project key-value store backed by Firebase Realtime Database
· Project secrets — environment variables stored encrypted, injected into backend scripts
· Deployment snapshots — versioned deploys with rollback
· User accounts — email + password auth with hashed passwords

Everything runs on Vercel's serverless platform. Every project gets its own URL, its own database, and its own sandboxed backend runtime.

What Folio is not

· Not a container system — no persistent processes, no custom runtimes
· Not a general-purpose compute platform — every invocation launches Chromium fresh (1.5–2s cold start)
· Not a replacement for a proper database — the JSON store is 15 MB and non-transactional

---

2. Architecture Overview

```
┌───────────────────────────────────────────────────────────────┐
│                       User's Browser                          │
│                                                               │
│  ┌─────────────────────────────────────────────────────────┐ │
│  │  Folio Editor (index.html, project.html)                │ │
│  │  ├─ CodeMirror 6 editor                                 │ │
│  │  ├─ Local IndexedDB project storage                     │ │
│  │  └─ Sync queue (offline-first writes)                   │ │
│  └─────────────────────────────────────────────────────────┘ │
│                                                               │
└───────────────────────────┬───────────────────────────────────┘
                            │ HTTPS
                            ▼
┌───────────────────────────────────────────────────────────────┐
│                     Vercel Serverless                          │
│                                                               │
│  ┌────────────────────────────────────────────────────────┐  │
│  │  api/host.js — the hosting API                          │  │
│  │  Handles: deploy, serve, DB writes, visibility,        │  │
│  │  auth, invites, exports, allowed-host management       │  │
│  └────────────────────────────────────────────────────────┘  │
│                                                               │
│  ┌────────────────────────────────────────────────────────┐  │
│  │  api/run.js — the private API runtime                   │  │
│  │  Spawns Chromium, executes api/*.js in a sandbox       │  │
│  └────────────────────────────────────────────────────────┘  │
│                                                               │
│  ┌────────────────────────────────────────────────────────┐  │
│  │  api/auth.js — session management                       │  │
│  │  api/ai.js — AI task dispatch                           │  │
│  └────────────────────────────────────────────────────────┘  │
│                                                               │
└───────────────────────────┬───────────────────────────────────┘
                            │
                            ▼
┌───────────────────────────────────────────────────────────────┐
│                 Firebase Realtime Database                     │
│                                                               │
│  projects/{pid}/         Project records, manifests           │
│  files/{pid}/            Public assets (served HTML/CSS/JS)   │
│  api-files/{pid}/        Private runtime scripts              │
│  versions/{pid}/         Deployment snapshots                 │
│  projectData/{pid}/      JSON database per project            │
│  projectSecrets/{pid}/   Encrypted secrets                    │
│  accounts/{emailKey}     User accounts with hashed passwords  │
│  apiLogs/{pid}/          Per-project API call log             │
└───────────────────────────────────────────────────────────────┘
```

Three distinct URL namespaces

Namespace Path Serves
Hosting API /api/host Deploy, serve, DB writes, visibility, exports
Runtime /api/run Private backend scripts (via rewrites)
User API /{username}/project/{slug}/api/{route} Friendly route to a user's api/*.js

---

3. Hosting Model

Public files vs private scripts

Every Folio project has two kinds of files:

Public files — stored in files/{pid}:

· Served over HTTP at /{username}/project/{slug}/{path}
· Visible to anyone with the URL (if visibility.liveSite is public)
· Assets: index.html, style.css, app.js, images
· Served with automatic relative URL rewriting

Private scripts — stored in api-files/{pid}:

· Never served over HTTP
· Only executed when called via /api/run
· Files: api/*.js
· Subject to the @allow external host model

The serving endpoint

Public files are served through api/host.js:

```
GET https://foliostudios.vercel.app/api/host?action=serve&pid=YOUR_PID&path=index.html
```

The serving handler:

1. Blocks private paths — path starting with api/ returns 404
2. Resolves relative URLs — rewrites <a href="about.html"> to /{username}/project/{slug}/about.html
3. Injects secrets — public secrets appear as window.__SECRETS__ in HTML
4. Injects analytics — a tracking snippet is appended before </body>
5. Injects meta tags — title, description, OG tags, canonical URL
6. Handles content types — infers MIME from extension
7. Handles binary assets — images, PDFs, fonts served raw

The friendly URL

A cleaner URL shape wraps the same serve endpoint:

```
https://foliostudios.vercel.app/{username}/project/{slug}/
```

Vercel rewrites this to:

```
/api/host?action=serve&pid={resolved_pid}&path=index.html
```

The pid is resolved from {username} + {slug} via a cached index at projectSlugs/{username}/{slug}.

---

4. Project Structure

Files you can create

```
your-project/
├── index.html           Public landing page
├── style.css            Public styles
├── app.js               Public JS (runs in the browser)
├── about.html           Additional public pages
├── assets/
│   ├── logo.png         Public images (base64 or URL)
│   └── data.json        Public data
└── api/                 Private backend
    ├── notes.js         Custom route → /api/notes
    ├── auth.js          Custom route → /api/auth
    └── _system.js       Six built-in system routes
```

File naming rules

Rule Why
api/*.js files are flat — no subfolders The runtime only scans the top level
Lowercase only Reserved for URL compatibility
No _ prefix except _system.js _ is reserved for system files
No reserved names — index.js, run.js, health.js, whoami.js, files.js, status.js, version.js, robots.js These would collide with internal routes
Max 10 files in api/ Including _system.js
Max 50 KB per file Entire script is embedded in HTML
Max 200 KB for the whole api/ folder Total payload budget

The _system.js file

Auto-created on first deploy. Contains six branches that respond to the six system routes:

```javascript
// api/_system.js (auto-generated)
if (REQ.route === "health") {
  return { status: "ok", pid: REQ.pid, deployed: REQ.deployedAt };
}
if (REQ.route === "whoami") {
  return { pid: REQ.pid, name: REQ.projectName, deployedAt: REQ.deployedAt };
}
// ... files, status, version, robots
```

You can edit it, but you can't delete it. Reverting restores the default.

---

5. The Private API Runtime

How a route is invoked

When a request arrives at:

```
POST /{username}/project/{slug}/api/chat
```

The sequence is:

1. Vercel rewrite → /api/run?username={username}&project={slug}&route=chat
2. run.js handler parses query params
3. Slug resolution — looks up pid from projectSlugs/{username}/{slug} (cached for 60s)
4. Auth — resolves the caller from Authorization: Bearer … or X-Project-Key: …
5. Rate limit — checks per-user, per-project, per-route limits
6. Load context — reads projects/{pid}, deployment, publicFileList, apiRoutes
7. Load script — reads api-files/{pid}/api__chat.js
8. Parse @allow hosts — merges file comments with the manifest
9. Build ENV — reserved vars + user secrets
10. Build REQ — method, body, headers, project metadata
11. Launch Chromium — fresh instance (~1.5–2s cold start)
12. Set content — embeds the script in a scaffold HTML page
13. Wait for __RESULT__ — max 7 seconds
14. Close browser — always in a finally block
15. Serialize response — coerce to string, apply content type, check size
16. Log — write to apiLogs/{pid} if user route
17. Return — send body with X-Request-Id, X-Execution-Time, X-Fetch-Hosts

Two URL shapes

Shape Example Resolution
Friendly /{username}/project/{slug}/api/chat Rewrite → resolve slug → pid
Direct /api/{pid}/chat Use pid directly

Both reach the same run.js handler. The direct form skips the slug lookup — one round trip faster.

The script scaffold

Your script runs inside this page:

```html
<!DOCTYPE html>
<html>
<head>
<script>
  window.ENV = Object.freeze({ ... });
  window.FILES = Object.freeze({ ... });
  window.REQ = Object.freeze({ ... });
</script>
</head>
<body>
<script type="module">
(async () => {
  try {
    const result = await (async () => {
      // YOUR SCRIPT HERE
    })();
    // ... process result, set window.__RESULT__
  } catch (err) {
    window.__RESULT__ = { ok: false, errorName: ..., errorMessage: ... };
  }
})();
</script>
</body>
</html>
```

The script is wrapped in an async IIFE so await works at the top level. Whatever you return becomes window.__RESULT__.body.

---

6. The Request Object (REQ)

REQ is frozen and available on every invocation.

Property Type Example
route string "chat"
method string "POST"
body object { message: "hello" }
headers object { "content-type": "application/json", "authorization": "Bearer …" }
query object { action: "list" } — the full query string
pid string "p_1792..."
username string \| null "alice"
projectSlug string \| null "my-project"
projectName string "My Project"
deploymentId string \| null "db_p_..._..."
deployedAt number \| null Unix ms
versionId string \| null "v_deploy_..."
gitCommit string \| null Commit hash if configured
deploymentUrl string \| null "https://foliostudios.vercel.app/alice/project/my-project"
apiFileCount number 3
publicFileCount number 8
publicFileList array [{ path, bytes, type }]
region string "iad1"
startTime number Unix ms when the handler entered
depth number Recursion depth (0 for top-level)
caller object \| null { route, depth } when called recursively

Body access

Always guard against an undefined body:

```javascript
const body = (REQ.body && typeof REQ.body === "object") ? REQ.body : {};
const action = typeof body.action === "string" ? body.action : "";
```

Header access

The runtime forwards only three headers for privacy:

```javascript
REQ.headers["content-type"]
REQ.headers["user-agent"]
REQ.headers["authorization"]    // ← critical for auth
```

If you need additional headers, include them in the request yourself — but understand they won't appear unless they match one of the three.

Query string access

The full query string is available on REQ.query, except pid, username, project, route — those are consumed by the runtime to identify the invocation. If you need to pass ?action=list, it lands on REQ.query.action.

---

7. The Environment Object (ENV)

ENV is the union of reserved variables (injected by the runtime) and user secrets (stored in the project's secret store).

Reserved variables (always present)

Key Value Example
PROJECT_ID The project's pid "p_1792..."
PROJECT_NAME Display name "My Project"
PROJECT_SLUG URL slug "my-project"
PROJECT_URL Canonical project URL "https://foliostudios.vercel.app/alice/project/my-project"
OWNER_USERNAME Owner's username "alice"
OWNER_UID Owner's user id "u_..."
DEPLOYMENT_ID Current deployment "db_p_..._..."
DEPLOYMENT_URL Deployed URL "https://foliostudios.vercel.app/alice/project/my-project"
FOLIO_BASE_URL Folio's base URL "https://foliostudios.vercel.app"
FOLIO_API_URL Folio's API base "https://foliostudios.vercel.app/api"
API_ROUTE Current route name "chat"
REQUEST_ID Unique invocation id "abc123..."

Reserved keys always win — you cannot override them with a secret of the same name.

User secrets

Any key you add in the Secrets tab appears in ENV. Secrets are decrypted per invocation, so treat them as ephemeral.

```javascript
const apiKey = ENV.OPENAI_API_KEY;
const dbUrl = ENV.SUPABASE_URL;
```

Guarding against missing secrets

Secrets you reference but haven't created are undefined:

```javascript
if (!ENV.OPENAI_API_KEY) {
  return { __status: 500, __body: "Server misconfigured: OPENAI_API_KEY" };
}
```

Inspecting ENV (debug only)

To see what keys are present without exposing values:

```javascript
return { envKeys: Object.keys(ENV || {}) };
```

Never return ENV directly — it contains your secrets.

---

8. The Files Object (FILES)

FILES is the project's public file list — metadata only, not contents.

```javascript
{
  files: [
    { path: "index.html", bytes: 842, type: "text/html; charset=utf-8" },
    { path: "style.css", bytes: 210, type: "text/css; charset=utf-8" },
    { path: "app.js", bytes: 1204, type: "application/javascript; charset=utf-8" }
  ],
  count: 3,
  totalBytes: 2256
}
```

FILES does not include private files (api/*.js) and never includes file contents. To read a public file from inside a script, use fetch against the serving endpoint:

```javascript
const r = await fetch(`${ENV.FOLIO_BASE_URL}/api/host?action=serve&pid=${ENV.PROJECT_ID}&path=index.html`);
const html = await r.text();
```

---

9. Returning Responses

The return contract

Whatever your script returns becomes the response body. The runtime inspects the shape:

You return Status Content-Type Body
{ success: true } 200 application/json Serialized object
"hello" 200 text/plain; charset=utf-8 "hello"
null or undefined 200 application/json "null"
42 200 application/json "42"
{ __status: 404, __body: "x", error: "x" } 404 application/json { "error": "x" }

Custom status and content type

Use the __-prefixed override keys:

```javascript
return {
  __status: 404,
  __contentType: "text/plain; charset=utf-8",
  __body: "Not found"
};
```

The runtime:

1. Reads __contentType and sets the Content-Type header
2. Reads __status and sets the HTTP status
3. Reads __body as the response body (string, object, or array — serialized if not a string)
4. Passes the whole object through to the log (any other fields are visible in apiLogs)

Serving HTML

```javascript
return {
  __contentType: "text/html; charset=utf-8",
  __body: "<!DOCTYPE html><html><body><h1>Hello</h1></body></html>"
};
```

Serving JSON

```javascript
return {
  users: [...],
  count: 42,
  meta: { page: 1 }
};
```

Serving a file

Read a public file and return it:

```javascript
const r = await fetch(`${ENV.FOLIO_BASE_URL}/api/host?action=serve&pid=${ENV.PROJECT_ID}&path=data.json`);
const text = await r.text();
return {
  __contentType: "application/json",
  __body: text
};
```

Response size limit

MAX_RESPONSE_BYTES = 5 MB. If you exceed it:

```javascript
return res.status(413).json({ success: false, error: "Response too large" });
```

Streaming is not supported — return the entire payload in one call.

---

10. The Database API

Every project has a JSON key-value store backed by Firebase Realtime Database. Up to 15 MB per project.

Layout

```
projectData/{pid}/          The root of the JSON tree
  users/                     Example: users collection
    u_abc123/                Individual user
      name: "Alice"
      at: 1762613422345
  posts/
    p_xyz/
      title: "..."
      heart: 42
```

Reads

db/get — returns the entire project tree:

```javascript
const r = await fetch(`${ENV.FOLIO_BASE_URL}/api/host?action=db/get&pid=${ENV.PROJECT_ID}`);
const { data } = await r.json();
```

data is the full root object. Walk it yourself:

```javascript
const users = data.users || {};
const user = users[userId];
```

db/list — returns items at a path (shape is implementation-dependent — prefer db/get for reliability):

```javascript
const r = await fetch(`${ENV.FOLIO_BASE_URL}/api/host?action=db/list&pid=${ENV.PROJECT_ID}&path=users`);
const { items } = await r.json();
```

Writes

db/set — write a single path:

```javascript
await fetch(`${ENV.FOLIO_BASE_URL}/api/host?action=db/set`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    pid: ENV.PROJECT_ID,
    key: "users/u_abc123",
    value: { name: "Alice", at: Date.now() }
  })
});
```

Delete a path — write null:

```javascript
await fetch(`${ENV.FOLIO_BASE_URL}/api/host?action=db/set`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    pid: ENV.PROJECT_ID,
    key: "users/u_abc123",
    value: null
  })
});
```

db/set with mode: "merge" — merge top-level keys (not deep):

```javascript
await fetch(`${ENV.FOLIO_BASE_URL}/api/host?action=db/set`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    pid: ENV.PROJECT_ID,
    data: { config: { theme: "dark" } },
    mode: "merge"
  })
});
```

db/set with mode: "replace" — replace the entire database:

```javascript
await fetch(`${ENV.FOLIO_BASE_URL}/api/host?action=db/set`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    pid: ENV.PROJECT_ID,
    data: { config: {}, users: {} }
  })
});
```

db/batch — atomic multi-path write:

```javascript
await fetch(`${ENV.FOLIO_BASE_URL}/api/host?action=db/batch`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    pid: ENV.PROJECT_ID,
    updates: [
      { key: `users/${id}`, value: user },
      { key: `usernames/${lower}`, value: { id } }
    ]
  })
});
```

db/increment — atomic increment:

```javascript
await fetch(`${ENV.FOLIO_BASE_URL}/api/host?action=db/increment`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    pid: ENV.PROJECT_ID,
    key: "posts/p_xyz/heart",
    by: 1
  })
});
```

Backend vs frontend access

From inside api/*.js: the runtime intercepts fetch(/api/host?action=db/…) in-process. No network, no auth header needed.

From the frontend:

```javascript
const r = await fetch(
  `${BASE}/api/host?action=db/set`,
  {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Project-Key": projectApiKey,
    },
    body: JSON.stringify({ pid, key, value }),
  }
);
```

Writes require the project API key (generated in the dashboard). Reads may be public if visibility.db is set to public.

Limits

Limit Value
Max size 15 MB
Write rate 100/hour per project
Transactions None — writes are last-writer-wins
Max batch updates 100
Max value size 2 MB
Key restrictions No . # $ / [ ] characters

Rules

· Firebase RTDB does not support arrays — they become { "0": ..., "1": ... }
· Writes are atomic per path — db/set either writes the whole value or nothing
· No transactions — use db/batch for atomic multi-writes, but be aware there's no read-modify-write guarantee
· db/increment is atomic — safe for counters

---

11. Secrets Management

What secrets are

Secrets are encrypted key-value pairs stored per project. They appear in ENV inside api/*.js scripts. They are never sent to the browser (unless you explicitly mark them public and enable injection).

Creating a secret

1. Open the project → Secrets tab
2. Click New secret
3. Enter the key (UPPER_SNAKE_CASE)
4. Enter the value
5. Choose visibility: Private (default) or Public
6. Save

Secret visibility

Visibility Where it appears
Private Only in ENV inside api/*.js
Public In ENV and in window.__SECRETS__ in served HTML (only when injection is enabled)

Public secrets appear in the browser — never store API keys, OAuth secrets, or database credentials as public.

Reserved names

You cannot create a secret with these names (they're injected automatically):

· PROJECT_ID, PROJECT_NAME, PROJECT_SLUG, PROJECT_URL
· OWNER_USERNAME, OWNER_UID
· DEPLOYMENT_ID, DEPLOYMENT_URL
· FOLIO_BASE_URL, FOLIO_API_URL
· API_ROUTE, REQUEST_ID

Injection mode

When Injection is enabled (Secrets tab → toggle):

· All public secrets are injected into every served HTML page as window.__SECRETS__
· Private secrets are not injected
· The injection is a <script> block inserted before </head>

Disable injection unless you specifically need public keys in the browser (e.g., Stripe publishable key).

Reading a secret in code

```javascript
// Private secret — safe
const openai = ENV.OPENAI_API_KEY;

// Missing secret
if (!ENV.OPENAI_API_KEY) {
  return { __status: 500, __body: "OPENAI_API_KEY not configured" };
}
```

Reading a public secret in the browser

```javascript
// Only works if STRIPE_PUBLISHABLE_KEY is marked public and injection is on
const stripeKey = window.__SECRETS__?.STRIPE_PUBLISHABLE_KEY;
```

Encryption at rest

Secrets are encrypted with AES-256-GCM before being stored in Firebase. The encryption key lives in the server environment (FOLIO_SECRETS_KEY), never in the database.

If FOLIO_SECRETS_KEY is not configured, the Secrets tab shows a warning and secrets are stored as plaintext. Set it before relying on secrets for anything sensitive.

Limits

Limit Value
Max value size 16 KB
Max total per project 512 KB
Max count 50

---

12. Allowed Hosts & External APIs

The four-tier allowlist

Scripts can only reach external hosts that have been explicitly allowed. Folio has four tiers:

Tier Stored in Applies to Example
Built-in API hosts BUILTIN_ALLOWED_HOSTS in run.js Every project api.openai.com
Trusted image hosts TRUSTED_IMAGE_HOSTS in run.js Every project picsum.photos
Allowed import hosts ALLOWED_IMPORT_HOSTS in run.js Every project cdn.jsdelivr.net
Per-project hosts projects/{pid}/allowedHosts One project Your custom API

What's in each tier

Built-in API hosts — well-known, safe APIs:

```
api.openai.com
api.groq.com
api.anthropic.com
api.stripe.com
api.paystack.co
api.supabase.co
api.resend.com
api.github.com
raw.githubusercontent.com
gist.githubusercontent.com
```

Trusted image hosts — public CDNs, always allowed:

```
picsum.photos
fastly.picsum.photos
images.unsplash.com
images.pexels.com
cdn.pixabay.com
upload.wikimedia.org
```

Allowed import hosts — for import statements:

```
cdn.jsdelivr.net
esm.sh
unpkg.com
cdnjs.cloudflare.com
ga.jspm.io
cdn.skypack.dev
```

Per-project hosts — anything added via @allow or auto-detected.

How @allow works

Add a comment at the top of your api/*.js:

```javascript
// @allow api.weather.com
// @allow api.open-meteo.com

const r = await fetch("https://api.open-meteo.com/v1/forecast");
return await r.json();
```

At deploy time, host.js scans for @allow comments, validates each host (DNS + HTTPS), and writes to projects/{pid}/allowedHosts.

At runtime, run.js reads the manifest and allows those hosts.

Auto-detection

You don't always need @allow. Folio also scans for literal https://host/... URLs in your script:

```javascript
const r = await fetch("https://api.example.com/v1/data");
```

On deploy, the scanner detects api.example.com, validates it, and adds it to the manifest.

What auto-detection cannot see:

```javascript
// ❌ Not detected — dynamic
const host = REQ.body.host;
const r = await fetch(`https://${host}/x`);

// ❌ Not detected — variable
const HOST = "api.example.com";
const r = await fetch(`https://${HOST}/x`);
```

For these, use @allow explicitly:

```javascript
// @allow api.example.com
```

Validating and adding hosts

Each host is validated at deploy time:

1. Resolves via DNS (must have public A/AAAA records)
2. Rejects private/reserved IPs (10.x, 127.x, 192.168.x, 169.254.x, IPv6 loopback, etc.)
3. Rejects Folio's own infrastructure (.vercel.app)
4. Rejects wildcards (*.example.com)
5. Rejects non-HTTPS hosts
6. Makes a HEAD request to verify HTTPS reachability

If validation fails, the deploy is rejected with a clear error listing which host failed and why.

Adding hosts from the dashboard

Project owners can add hosts without editing code:

```
POST /api/host?action=hosts/add
{
  "pid": "p_...",
  "host": "api.my-api.com"
}
```

The backend validates DNS + HTTPS and writes to the manifest. Added hosts are tagged declaredBy: ["dashboard"] so they persist through redeploys.

What happens when a fetch is blocked

If your script fetches a host that isn't allowed:

1. run.js aborts the request with blockedbyclient
2. Your script sees a TypeError: Failed to fetch
3. run.js logs run.host_blocked with the hostname
4. The API tab's log view shows the blocked host

Diagnosing blocked fetches:

1. Check the API log entry — run.host_blocked lists the host
2. Add // @allow host.name to your script
3. Or include a literal https://host.name/... URL somewhere
4. Or add it via the dashboard
5. Redeploy

Limits

Limit Value
Unique hosts per project 50
@allow lines per file 20

---

13. Authentication Patterns

Folio does not require authentication before running your script. Auth is entirely your script's decision. This lets you mix public endpoints (register, login, webhooks) with protected ones (list, update, delete).

The three auth methods

The runtime resolves the caller from one of three sources:

Source Header via in logs
Session token Authorization: Bearer <token> "session"
Project API key X-Project-Key: <key> "api-key"
Neither — "anon"

Anonymous requests are still allowed but rate-limited per IP.

Referencing the caller in your script

Do not use REQ.headers.authorization to check auth status — the runtime doesn't require it and that header can be spoofed from the frontend. Instead, verify tokens yourself inside the script:

```javascript
const action = REQ.body?.action;

if (action === "register" || action === "login") {
  // Public — no token needed
  return handleRegisterOrLogin(REQ.body);
}

// Everything else needs a session
const session = await verifyMySession(REQ.headers.authorization);
if (!session) {
  return { __status: 401, __body: "Unauthorized", error: "Not signed in" };
}

// ... proceed with authenticated action
```

The recommended auth stack

For a full app, you need:

1. User accounts — email + password, hashed with PASSWORD_SALT
2. Session tokens — HMAC-signed with SESSION_SECRET
3. Password hashing — pure-JS SHA-256 (because crypto.subtle doesn't exist in the sandbox)
4. Session verification — HMAC + expiry + passwordChangedAt check

The complete reference implementation is in api/notes.js. Copy the crypto helpers into any new auth-enabled app:

```javascript
// Pure-JS SHA-256 — works in the sandbox
function sha256Hex(str) { /* ... */ }

// HMAC-SHA256 — works in the sandbox
function hmacSign(data) { /* ... */ }

// Password hashing
function hashPassword(password) {
  return sha256Hex(PASSWORD_SALT + "|" + password + "|" + PASSWORD_SALT);
}

// Session token creation
function createSessionToken(userId) {
  const expiry = Date.now() + SESSION_TTL_MS;
  const payload = userId + "|" + expiry;
  const sig = hmacSign(payload);
  return btoa(payload).replace(/=+$/, "") + "." + sig;
}

// Session token verification
function verifySessionToken(token) {
  const [b64, sig] = token.split(".");
  const payload = atob(b64);
  const expectedSig = hmacSign(payload);
  if (sig !== expectedSig) return null;
  const [userId, expiry] = payload.split("|");
  if (Number(expiry) < Date.now()) return null;
  return { userId, expiry };
}
```

Rate limiting by auth state

The runtime automatically attributes rate limits:

· Authenticated (Bearer or API key) → per-user bucket
· Anonymous → per-IP bucket

You don't have to do anything — enforceRate uses sessionId derived from the caller.

Session TTL

Folio's default session TTL is 30 days. You can shorten it in your script:

```javascript
const SESSION_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
```

Invalidating sessions on password change

Store passwordChangedAt on the account:

```javascript
await dbSet(`accounts/${emailKey}/passwordChangedAt`, Date.now());
```

Then in resolveSession:

```javascript
if (account.passwordChangedAt && account.passwordChangedAt > (tokenExpiry - SESSION_TTL_MS)) {
  return null;  // Token predates the last password change
}
```

Password strength requirements

Enforce minimum length in your register handler:

```javascript
function validatePassword(password) {
  if (typeof password !== "string") return "Password is required";
  if (password.length < 8) return "Password must be at least 8 characters";
  if (password.length > 200) return "Password is too long";
  return null;
}
```

Add complexity rules if you want:

```javascript
if (!/[A-Z]/.test(password)) return "Add an uppercase letter";
if (!/[0-9]/.test(password)) return "Add a number";
if (!/[^a-zA-Z0-9]/.test(password)) return "Add a symbol";
```

Rate-limiting login attempts

```javascript
const _attempts = {};

function checkLoginRate(email) {
  const key = "login_" + email;
  const now = Date.now();
  const rec = _attempts[key];
  if (!rec || now > rec.resetAt) {
    _attempts[key] = { count: 1, resetAt: now + 15 * 60 * 1000 };
    return true;
  }
  if (rec.count >= 10) return false;
  rec.count++;
  return true;
}
```

This is in-memory — resets on cold start. For persistent rate limits, use the DB.

---

14. The Chromium Sandbox

Every invocation launches a fresh Chromium instance (via @sparticuz/chromium-min + puppeteer-core). Your script runs as a module inside a page created with page.setContent(html).

What this means for your code

Available:

· fetch, crypto.getRandomValues, TextEncoder, TextDecoder, Date, Math, JSON, Intl, URL, URLSearchParams, Promise, setTimeout, clearTimeout, AbortController
· localStorage — but not sessionStorage (page is about:blank)
· DOMParser, document, window — but the page has no visible body
· All the Web APIs Chromium supports

NOT available:

· crypto.subtle — requires secure context (page is about:blank)
· crypto.randomUUID — requires secure context
· navigator.share, navigator.clipboard — require secure context or user gesture
· WebSocket to arbitrary hosts — blocked by the interceptor
· fetch to /api/host — must use absolute URL from ENV.FOLIO_BASE_URL
· import from external CDNs — only cdn.jsdelivr.net, esm.sh, unpkg.com, cdnjs.cloudflare.com, ga.jspm.io, cdn.skypack.dev

The crypto.subtle problem

crypto.subtle is gated on self.isSecureContext. Since the runtime uses page.setContent(), the page origin is about:blank, which is not a secure context. Any attempt to use it throws:

```
TypeError: Cannot read properties of undefined (reading 'digest')
```

Solutions:

Wrong Right
crypto.randomUUID() crypto.getRandomValues-based uuid()
crypto.subtle.digest("SHA-256", ...) Pure-JS sha256Hex(str)
crypto.subtle.sign(..., "HMAC", ...) Pure-JS hmacSign(data)

See api/notes.js for working implementations.

The relative-URL problem

fetch("/api/host?action=db/get&pid=...") in the sandbox throws:

```
TypeError: Failed to parse URL from /api/host?...
```

Because the page origin is about:blank, relative URLs have nothing to resolve against.

Solution: always use an absolute URL from ENV.FOLIO_BASE_URL:

```javascript
const BASE = ENV.FOLIO_BASE_URL;
const r = await fetch(`${BASE}/api/host?action=db/get&pid=${ENV.PROJECT_ID}`);
```

The import allowlist

import statements can only resolve to allowlisted CDN hosts:

```javascript
// ✅ Allowed
import { marked } from "https://cdn.jsdelivr.net/npm/marked@12/marked.esm.js";

// ❌ Blocked
import { marked } from "https://my-custom-cdn.com/marked.js";
```

The allowlist is ALLOWED_IMPORT_HOSTS in run.js.

Intercepting fetch

The runtime intercepts every request your script makes. For each:

· /api/host?action=db/… → handled in-process, no network
· Internal Folio hosts (folio, {FOLIO_HOST}) → blocked unless it's /api/host?action=db/…
· BUILTIN_ALLOWED_HOSTS → allowed, tracked in X-Fetch-Hosts
· TRUSTED_IMAGE_HOSTS → allowed, tracked
· ALLOWED_IMPORT_HOSTS → allowed (for imports)
· projects/{pid}/allowedHosts → allowed, tracked
· Everything else → blocked with blockedbyclient, logged as run.host_blocked

Timeouts

Timeout Value Scope
Chromium launch 15s Cold start
Page setup 5s page.setContent()
User code 7s page.waitForFunction()
Total function 30s Vercel maxDuration

If your script takes more than 7s, it returns 504 and logs stage: "waitforfunction_started".

Optimization tips:

· Reduce external fetches — each one adds latency
· Cache aggressively within a single invocation
· Do multiple DB operations in db/batch instead of sequential db/set calls
· For cold-start-heavy workloads, accept that each call is ~2s minimum

---

15. Deployment Lifecycle

What "deploy" means

Deploying a project:

1. Writes all files to files/{pid} (public) or api-files/{pid} (private)
2. Scans api/*.js for @allow comments and literal https://host/... URLs
3. Validates detected hosts via DNS + HTTPS (parallel, skipping known-safe hosts)
4. Writes the host manifest to projects/{pid}/allowedHosts
5. Registers routes — writes projects/{pid}/apiRoutes = { system: [...], user: [...] }
6. Creates a version snapshot — writes versions/{pid}/v_deploy_*
7. Ensures _system.js exists — auto-creates it if missing
8. Writes the deployment record — projects/{pid}/deployment with URL, deployment ID, timestamp
9. Prunes old deployments — keeps last 5
10. Returns — { success, url, deploymentId, versionId, ... }

Prerequisites

· User must have editor role on the project
· Project must exist in the database
· files must contain at least one valid file
· No API file may violate file rules

The deploy request

```javascript
await fetch(`${BASE}/api/host?action=deploy`, {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "Authorization": `Bearer ${sessionToken}`,
  },
  body: JSON.stringify({
    pid: "p_...",
    files: {
      "index.html": "<!DOCTYPE html>...",
      "style.css": "body {...}",
      "app.js": "console.log('hi')",
      "api/hello.js": "return { message: 'hi' }",
    },
  }),
});
```

Success response

```json
{
  "success": true,
  "deploymentId": "db_p_..._...",
  "url": "https://foliostudios.vercel.app/alice/project/my-project",
  "versionId": "v_deploy_...",
  "filesWritten": 4,
  "filesSkipped": 0,
  "apiFileCount": 2,
  "allowedHosts": ["api.example.com"]
}
```

Error responses

Status Meaning
400 Invalid file, reserved name, too many files, size limit
403 User doesn't have editor role
404 Project not found
413 Payload exceeds size limit
500 Backend error

Redeploy

Redeploy a previous version:

```javascript
await fetch(`${BASE}/api/host?action=redeploy`, {
  method: "POST",
  headers: { "Content-Type": "application/json", "Authorization": `Bearer ${token}` },
  body: JSON.stringify({ pid, versionId: "v_deploy_..." }),
});
```

Take offline

```javascript
await fetch(`${BASE}/api/host?action=deployment/offline`, {
  method: "POST",
  headers: { "Content-Type": "application/json", "Authorization": `Bearer ${token}` },
  body: JSON.stringify({ pid }),
});
```

Sets state: "OFFLINE", clears the URL, saves previousUrl for reference.

Delete a deployment

```javascript
await fetch(`${BASE}/api/host?action=deployment/delete`, {
  method: "POST",
  headers: { "Content-Type": "application/json", "Authorization": `Bearer ${token}` },
  body: JSON.stringify({ pid, deploymentId }),
});
```

Deletes the deployment record and its version snapshot. Owner only.

Deployment history

```javascript
await fetch(`${BASE}/api/host?action=deployment/history&pid=${pid}`, {
  headers: { "Authorization": `Bearer ${token}` },
});
```

Returns the last N deployments with timestamps, URLs, thumbnails, and whether each has a restorable snapshot.

Version snapshots

Every deploy creates a version snapshot in versions/{pid}/v_deploy_*. These are separate from user-created commits.

Kind Created by Restorable
deploy Deploy pipeline Yes, via redeploy
User commit Editor's Commit dialog Yes, via git-like operations

Deployment pruning

Only the 5 most recent deployments are kept. Older ones are deleted along with their version snapshots.

---

16. System Routes

Every project gets six system routes from _system.js. They're available at:

```
GET /{username}/project/{slug}/api/{route}
POST /{username}/project/{slug}/api/{route}
GET /api/{pid}/{route}
```

The six routes

health — liveness check:

```json
{ "status": "ok", "pid": "p_...", "deployed": 1762613422345, "responseMs": 245 }
```

whoami — project identity:

```json
{ "pid": "p_...", "name": "My Project", "deployedAt": 1762613422345, "apiVersion": 1 }
```

files — public file list:

```json
{ "files": [...], "count": 3, "totalBytes": 2256 }
```

status — richer health:

```json
{
  "status": "ok",
  "pid": "p_...",
  "deployed": 1762613422345,
  "responseMs": 245,
  "region": "iad1",
  "runtime": "chromium",
  "apiFiles": 3,
  "publicFiles": 8,
  "lastError": null,
  "lastErrorAt": null
}
```

version — deployment metadata:

```json
{
  "deploymentId": "db_p_..._...",
  "deployedAt": 1762613422345,
  "versionId": "v_deploy_...",
  "gitCommit": null,
  "url": "https://foliostudios.vercel.app/alice/project/my-project"
}
```

robots — plain-text robots.txt:

```
User-agent: *
Allow: /
Disallow: /api/
```

When to use system routes

· Health checks — ping /health to confirm the runtime is alive
· Frontend metadata — call /whoami to get the project name, deployed timestamp
· File listing — call /files to build a directory index without reading the DB
· Debugging — call /status to see if the runtime is degraded

Customizing _system.js

You can edit _system.js like any other file. Changes apply on next deploy. Reverting restores the default.

---

17. Rate Limiting

Every invocation is rate-limited across five buckets:

Bucket Max Window
Per session, per route 10 60s
Per session, all routes 50 60s
Per project, all routes 500 1h
Per project, all routes 2,000 24h
Per project, per route 100 1h

Who counts as a session

· Anonymous → anon_{ip_hash} — per IP
· Session token → user_{uid} — per user
· API key → key_{ip_hash} — per IP (API key is shared across clients)

Rate limit responses

When a limit is exceeded:

```json
{
  "success": false,
  "error": "Rate limit exceeded",
  "retryAfter": 60
}
```

With Retry-After: 60 header.

Bypassing rate limits (dashboard only)

The hosting API (/api/host) has its own rate limits per action. These are separate from the runtime limits.

If you hit the runtime limits during testing, options:

· Sign in (per-user limits are separate from anonymous)
· Use the direct URL instead of the friendly one (avoids one rate-limit check)
· Wait

Rate limit headers

On some endpoints, Folio returns:

```
X-RateLimit-Limit: 10
X-RateLimit-Remaining: 7
X-RateLimit-Reset: 2026-11-09T14:32:00.000Z
```

---

18. Logging & Observability

Three log sources

1. run.timing — structured stage logs

Every invocation emits a run.timing event at each stage. Visible in Vercel's function logs.

```
run.timing { reqId: "abc123", stage: "entered", elapsed: 0 }
run.timing { reqId: "abc123", stage: "auth_done", elapsed: 45 }
run.timing { reqId: "abc123", stage: "chromium_launch_started", elapsed: 120 }
run.timing { reqId: "abc123", stage: "chromium_launch_done", elapsed: 1890 }
run.timing { reqId: "abc123", stage: "page_executed", elapsed: 2340 }
run.timing { reqId: "abc123", stage: "completed", elapsed: 2360 }
```

The stage names tell you exactly where time was spent.

2. apiLogs/{pid} — per-project ring buffer

Recorded only for user routes (api/*.js). The last 50 entries per project, pruned by timestamp.

Each entry contains:

Field Meaning
id Unique log id
ts Unix ms
route Route name ("chat")
method HTTP method
status Response status
durationMs Total time
errorName, errorMessage If the script threw
via anon, session, or api-key
requestId Correlates with the X-Request-Id header
stage Last stage reached (for failures)
bytesIn, bytesOut Payload sizes
fetchHosts External hosts reached
userAgent, ipHash Client info
deploymentId Which deploy handled the call

Read via API:

```
GET /api/host?action=api-logs&pid=YOUR_PID&limit=20&offset=0
```

With filters:

```
GET /api/host?action=api-logs&pid=YOUR_PID&status=error
GET /api/host?action=api-logs&pid=YOUR_PID&route=chat&via=api-key
GET /api/host?action=api-logs&pid=YOUR_PID&since=1762613422345
```

Read in the dashboard: open the project → API tab → Recent calls.

3. logs/project/{pid} — project activity events

Every meaningful action is logged: deploys, secret changes, visibility updates, invites, DB writes.

Read via:

```
GET /api/host?action=logs&pid=YOUR_PID&limit=50&offset=0
```

The X-Request-Id header

Every response carries a unique X-Request-Id. Quote it when:

· Reporting a bug
· Correlating a client failure with a server log
· Debugging in the dashboard

Response headers for observability

Header Meaning
X-Request-Id Unique invocation id
X-Execution-Time Total ms
X-Fetch-Hosts Comma-separated external hosts reached
X-Project-Format For exports: folio or zip
X-Project-Files For exports: file count

Vercel logs

For deep debugging, open Vercel's function logs for api/run. Filter by reqId to see the full invocation timeline.

---

19. Error Handling

The response contract

Scenario Status Body
Script returns a value 200 (or __status) Serialized value
Script throws 500 { success: false, error: "Function threw an error" }
Script times out (7s) 504 { success: false, error: "Function timed out" }
Route not found 404 { success: false, error: "Route not found" }
File not found 404 { success: false, error: "Route file not found" }
Project not found 404 { success: false, error: "Project not found" }
Missing pid 400 { success: false, error: "Missing pid" }
Invalid route 400 { success: false, error: "Invalid route name" }
Recursion depth exceeded 508 { success: false, error: "Recursion limit exceeded" }
Body too large 413 { success: false, error: "Request body exceeds 1024 KB" }
Response too large 413 { success: false, error: "Response too large" }
Rate limited 429 { success: false, error: "Rate limit exceeded", retryAfter }

The null response bug

If your script returns undefined from a branch:

```javascript
if (action === "unknown") {
  // no return — falls through
}
```

You'll get "null" as the response body with status 200. The runtime coerces undefined to "null" to prevent a crash, but "null" is not what any client wants.

Fix: wrap your entire script:

```javascript
try {
  // all your actions
  return { __status: 400, error: "Unknown action" };
} catch (e) {
  return { __status: 500, error: "Script error: " + e.message };
}
```

Now any unreturned branch returns the unknown-action error, and any throw returns a clean 500.

The Buffer.byteLength(undefined) crash

Older versions of run.js had a bug: JSON.stringify(undefined) returns undefined, and Buffer.byteLength(undefined) throws. This is fixed in the current runtime — if you see it, update run.js.

Distinguishing clean rejections from crashes

Signal Clean rejection (400-499) Crash (500+)
stage browser_closed or completed waitforfunction_started (timeout) or page_executed (throw)
bytesOut 0 (real body) 0 (no response)
errorName null "TypeError", "SyntaxError"
errorMessage null The thrown message
status 4xx 5xx

Common errors and fixes

Error Cause Fix
Failed to parse URL from /api/host Relative URL in sandbox Prefix with ENV.FOLIO_BASE_URL
crypto.randomUUID is not a function Secure-context API in sandbox Use crypto.getRandomValues-based UUID
crypto.subtle is undefined Secure-context API in sandbox Use pure-JS SHA-256/HMAC
TypeError: Failed to fetch Blocked external host Add @allow or literal URL
"null" in response Script returned undefined Wrap in try/catch, return fallback
Function timed out Script >7s Optimize, batch DB operations
Unknown action at top Missing action dispatcher Add fallback return
Form not found Wrong pid or deleted Check pid in dashboard URL
Session expired Token older than TTL or password changed Re-login

---

20. Building a Full App — Worked Example

Let's build a complete notes app with authentication. This mirrors api/notes.js from the repo.

Step 1 — Set the two auth secrets

In the project's Secrets tab, add:

· PASSWORD_SALT — crypto.randomUUID() + crypto.randomUUID()
· SESSION_SECRET — crypto.randomUUID() + crypto.randomUUID()

Save. These must not change once users register.

Step 2 — Write api/notes.js

```javascript
// api/notes.js
const pid = ENV.PROJECT_ID;
const HOST_BASE = ENV.FOLIO_BASE_URL;
const PASSWORD_SALT = ENV.PASSWORD_SALT;
const SESSION_SECRET = ENV.SESSION_SECRET;

// ── Guards
if (!pid || !HOST_BASE) return { __status: 500, error: "Runtime misconfigured" };
if (!PASSWORD_SALT || !SESSION_SECRET) {
  return { __status: 500, error: "Missing PASSWORD_SALT or SESSION_SECRET" };
}

// ── Crypto (pure JS — works in sandbox)
function sha256Hex(str) { /* ... */ }
function hmacSign(data) { /* ... */ }
function hashPassword(pw) { return sha256Hex(PASSWORD_SALT + "|" + pw + "|" + PASSWORD_SALT); }

// ── DB helpers
async function dbGet(path) {
  const r = await fetch(`${HOST_BASE}/api/host?action=db/get&pid=${encodeURIComponent(pid)}`);
  const j = await r.json();
  const tree = j?.data || {};
  return walk(tree, path);
}
async function dbSet(key, value) {
  return fetch(`${HOST_BASE}/api/host?action=db/set`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ pid, key, value }),
  });
}
async function dbBatch(updates) {
  return fetch(`${HOST_BASE}/api/host?action=db/batch`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ pid, updates }),
  });
}
function walk(obj, path) {
  if (!path) return obj;
  return path.split("/").filter(Boolean).reduce((c, k) => c?.[k], obj);
}

// ── Session tokens
function createSessionToken(userId) { /* ... */ }
function verifySessionToken(token) { /* ... */ }
async function resolveSession(token) {
  const v = verifySessionToken(token);
  if (!v) return null;
  const accounts = await dbGet("accounts");
  for (const k in accounts) {
    if (accounts[k]?.id === v.userId) return { userId: v.userId, account: accounts[k], accountKey: k };
  }
  return null;
}

// ── Action dispatch
const body = REQ.body || {};
const action = body.action || "";

try {
  // REGISTER
  if (action === "register") {
    const email = String(body.email || "").toLowerCase().trim();
    const password = String(body.password || "");
    if (!email || !password) return { __status: 400, error: "Missing email or password" };
    if (password.length < 8) return { __status: 400, error: "Password too short" };

    const key = email.replace(/[.#$\/\[\]@]/g, "_");
    const existing = await dbGet(`accounts/${key}`);
    if (existing?.id) return { __status: 409, error: "Account exists" };

    const id = crypto.randomUUID ? crypto.randomUUID() : (Date.now() + "-" + Math.random());
    const account = { id, email, passwordHash: hashPassword(password), createdAt: Date.now() };
    await dbSet(`accounts/${key}`, account);
    const token = createSessionToken(id);
    return { success: true, user: { id, email }, token };
  }

  // LOGIN
  if (action === "login") {
    const email = String(body.email || "").toLowerCase().trim();
    const password = String(body.password || "");
    const key = email.replace(/[.#$\/\[\]@]/g, "_");
    const account = await dbGet(`accounts/${key}`);
    if (!account?.id) return { __status: 401, error: "Invalid credentials" };
    if (hashPassword(password) !== account.passwordHash) {
      return { __status: 401, error: "Invalid credentials" };
    }
    const token = createSessionToken(account.id);
    return { success: true, user: { id: account.id, email: account.email }, token };
  }

  // SESSION CHECK
  if (action === "session") {
    const resolved = await resolveSession(String(body.token || ""));
    if (!resolved) return { __status: 401, error: "Session expired" };
    return { success: true, user: { id: resolved.userId, email: resolved.account.email } };
  }

  // CREATE NOTE (authenticated)
  if (action === "createNote") {
    const resolved = await resolveSession(String(body.token || ""));
    if (!resolved) return { __status: 401, error: "Sign in first" };

    const id = "n_" + (crypto.randomUUID ? crypto.randomUUID() : Date.now());
    const note = {
      ownerId: resolved.userId,
      title: String(body.title || "Untitled").slice(0, 200),
      content: String(body.content || "").slice(0, 100000),
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    await dbBatch([
      { key: `notes/${id}`, value: note },
      { key: `userNotes/${resolved.userId}/${id}`, value: { title: note.title, updatedAt: note.updatedAt } },
    ]);
    return { success: true, note: { id, ...note } };
  }

  // LIST NOTES (authenticated)
  if (action === "listNotes") {
    const resolved = await resolveSession(String(body.token || ""));
    if (!resolved) return { __status: 401, error: "Sign in first" };

    const userNotes = (await dbGet(`userNotes/${resolved.userId}`)) || {};
    const list = [];
    for (const id in userNotes) {
      list.push({ id, ...userNotes[id] });
    }
    list.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    return { success: true, notes: list };
  }

  // FALLBACK
  return { __status: 400, error: "Unknown action: " + action };

} catch (e) {
  return { __status: 500, error: "Script error: " + e.message };
}
```

Step 3 — Write index.html

```html
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Notes</title>
</head>
<body>
  <div id="auth"></div>
  <div id="app" style="display:none"></div>
  <script>
    const API = "/{username}/project/{slug}/api/notes";
    let token = localStorage.getItem("token");

    async function call(action, extra = {}) {
      const r = await fetch(API, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, ...extra }),
      });
      return r.json();
    }

    async function login(email, password) {
      const r = await call("login", { email, password });
      if (r.error) return alert(r.error);
      token = r.token;
      localStorage.setItem("token", token);
      loadApp();
    }

    async function register(email, password) {
      const r = await call("register", { email, password });
      if (r.error) return alert(r.error);
      token = r.token;
      localStorage.setItem("token", token);
      loadApp();
    }

    async function loadApp() {
      const r = await call("listNotes", { token });
      if (r.error) {
        document.getElementById("app").style.display = "none";
        document.getElementById("auth").style.display = "block";
        return;
      }
      document.getElementById("auth").style.display = "none";
      document.getElementById("app").style.display = "block";
      document.getElementById("app").innerHTML = `
        <h1>Your notes (${r.notes.length})</h1>
        <button onclick="newNote()">New note</button>
        <ul>
          ${r.notes.map(n => `<li>${n.title}</li>`).join("")}
        </ul>
      `;
    }

    async function newNote() {
      const title = prompt("Title:");
      if (!title) return;
      const r = await call("createNote", { token, title, content: "# " + title });
      if (r.error) return alert(r.error);
      loadApp();
    }

    document.getElementById("auth").innerHTML = `
      <h1>Sign in or register</h1>
      <input id="email" type="email" placeholder="Email">
      <input id="password" type="password" placeholder="Password">
      <button onclick="login(email.value, password.value)">Sign in</button>
      <button onclick="register(email.value, password.value)">Register</button>
    `;

    if (token) loadApp();
  </script>
</body>
</html>
```

Step 4 — Deploy

```javascript
await fetch("/api/host?action=deploy", {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "Authorization": `Bearer ${sessionToken}`,
  },
  body: JSON.stringify({
    pid: "YOUR_PID",
    files: {
      "index.html": "<!DOCTYPE html>...",  // your HTML
      "api/notes.js": "// your script...",  // your script
    },
  }),
});
```

Step 5 — Test

1. Open /{username}/project/{slug}/
2. Enter email + password → click Register
3. You're signed in
4. Click New note → enter a title
5. Note appears in the list

Debugging:

If login fails:

1. Open the project → API tab → Recent calls
2. Find the register or login entry
3. Check status, errorName, errorMessage

If notes don't load:

1. Same Recent calls view
2. Look for the listNotes entry
3. Check errorName — often "Session expired" or a DB shape mismatch

---

21. Frontend Integration

Calling your API

Direct fetch:

```javascript
const res = await fetch("/{username}/project/{slug}/api/notes", {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "Authorization": `Bearer ${localStorage.getItem("token")}`,
  },
  body: JSON.stringify({ action: "listNotes" }),
});
const data = await res.json();
```

With a wrapper:

```javascript
const API = "/{username}/project/{slug}/api/notes";

async function api(action, extra = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 25000);
  try {
    const res = await fetch(API, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(localStorage.getItem("token") && {
          "Authorization": `Bearer ${localStorage.getItem("token")}`,
        }),
      },
      body: JSON.stringify({ action, ...extra }),
      signal: ctrl.signal,
    });
    if (!res.ok && res.status !== 400 && res.status !== 401) {
      throw new Error(`Server returned ${res.status}`);
    }
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}
```

Handling errors

Your API always returns JSON. Errors look like:

```json
{ "__status": 401, "__body": "Sign in first", "error": "Sign in first" }
```

Client code:

```javascript
const r = await api("listNotes");
if (r.error) {
  if (r.__status === 401) {
    localStorage.removeItem("token");
    showLogin();
    return;
  }
  toast(r.error);
  return;
}
// use r.notes
```

Session persistence

Store the token in localStorage:

```javascript
localStorage.setItem("token", r.token);
```

On page load, validate it:

```javascript
const token = localStorage.getItem("token");
if (token) {
  const s = await api("session", { token });
  if (s.success) {
    currentUser = s.user;
    showApp();
  } else {
    localStorage.removeItem("token");
    showLogin();
  }
}
```

CORS

Folio's run.js sets:

```
Access-Control-Allow-Origin: *
Access-Control-Allow-Methods: GET, POST, PUT, PATCH, DELETE, OPTIONS
Access-Control-Allow-Headers: Content-Type, Authorization, X-Project-Key, X-Recursion-Depth, X-Caller-Route
```

You can call your API from any origin. Preflight OPTIONS returns 204 immediately.

Calling from another domain

```javascript
const API = "https://foliostudios.vercel.app/alice/project/notes/api/notes";
const r = await fetch(API, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ action: "listNotes", token }),
});
```

CORS headers are set automatically.

Calling from the browser vs from a script

From the browser: use relative or absolute URLs, auth via Authorization: Bearer <session>.

From another api/*.js script: use fetch with the full URL. Note: calls to your own API from your own API count against the recursion limit (max 3). For most use cases, don't call your own API — just inline the logic.

---

22. Environment Variables

Platform (Vercel) — set once per deployment

Variable Required Purpose
BASE_URL Yes Canonical URL, used in every generated link
FIREBASE_PROJECT_ID Yes Firebase project
FIREBASE_CLIENT_EMAIL Yes Firebase service account
FIREBASE_PRIVATE_KEY Yes Firebase service account
ADMIN_API_KEY Yes Admin operations
FOLIO_SECRETS_KEY Recommended AES-256-GCM key for secret encryption
FLIER_INTERNAL_URL Optional Image generation
GROQ_API_KEY Optional AI features
GROQ_MODEL Optional Primary model
GROQ_MODEL_FAST Optional Fast model

Per-project (Secrets tab) — set per project

Any UPPER_SNAKE_CASE key. Read via ENV.KEY_NAME in api/*.js.

Common ones:

Key Used for
OPENAI_API_KEY OpenAI API calls
STRIPE_SECRET_KEY Stripe payments
STRIPE_PUBLISHABLE_KEY Client-side Stripe (public)
SUPABASE_URL Supabase project URL
SUPABASE_ANON_KEY Supabase client (public)
DATABASE_URL Custom DB connection
PASSWORD_SALT Auth pepper (for notes apps)
SESSION_SECRET Session HMAC key (for notes apps)

Reserved names (cannot be set as secrets)

```
PROJECT_ID, PROJECT_NAME, PROJECT_SLUG, PROJECT_URL
OWNER_USERNAME, OWNER_UID
DEPLOYMENT_ID, DEPLOYMENT_URL
FOLIO_BASE_URL, FOLIO_API_URL
API_ROUTE, REQUEST_ID
```

Debugging missing env

```javascript
if (!ENV.MY_KEY) {
  return {
    __status: 500,
    error: "MY_KEY not configured",
    envKeys: Object.keys(ENV || {}),  // shows what IS set
  };
}
```

Never return ENV itself — it contains secrets.

---

23. Debugging Playbook

When something goes wrong, follow this sequence.

Step 1 — Open the API logs

Dashboard → API tab → Recent calls.

Or via API:

```
GET /api/host?action=api-logs&pid=YOUR_PID
```

Find the failing call. Note:

· status
· stage
· errorName, errorMessage
· requestId

Step 2 — Interpret the stage

Stage What it means
entered Request arrived
query_parsed Bad pid/route in URL
slug_resolved Username + slug didn't resolve
auth_done Caller resolved (or anonymous)
rate_done Rate limit check completed
ctx_loaded Project record and routes loaded
route_file_loaded Script file read
hosts_parsed @allow hosts merged from manifest
secrets_loaded ENV built
env_built Reserved env merged
html_built Scaffold page created
browser_launch_started Chromium launch started
chromium_modules_loaded Module import done
chromium_extracted Chromium binary extracted
chromium_launch_done Browser started
new_page_started / new_page_done Page created
setcontent_started / setcontent_done HTML loaded
waitforfunction_started Waiting for script
waitforfunction_done Script finished
page_executed Script ran and returned
browser_closed Cleanup complete
completed Response sent

Step 3 — Check the response body

If status is 4xx and errorName is null, the script returned an error object. That's a clean rejection — read errorMessage for the reason.

If status is 5xx and errorName is set, the script threw — read errorName + errorMessage.

Step 4 — Correlate with Vercel logs

The requestId from the API log matches the X-Request-Id response header. Search Vercel logs for that ID to see the full stage timing.

Step 5 — Check the response headers

· X-Request-Id — unique per call
· X-Execution-Time — total ms
· X-Fetch-Hosts — external hosts reached

If X-Fetch-Hosts is empty but the script did a fetch, the request was blocked (no host was reached). Look for run.host_blocked in the logs.

Step 6 — Common fixes

"Failed to parse URL"

→ fetch("/api/host") in sandbox. Use ${ENV.FOLIO_BASE_URL}/api/host.

"crypto.randomUUID is not a function"

→ Secure-context API in sandbox. Use crypto.getRandomValues-based UUID.

"crypto.subtle is undefined"

→ Secure-context API in sandbox. Use pure-JS SHA-256/HMAC.

"null" in response

→ Script returned undefined. Wrap in try/catch, return fallback.

"Unknown action: undefined"

→ Missing action in request body. Check your frontend sends it.

List returning empty

→ db/get vs db/list shape mismatch. Use db/get + walk.

Form not appearing after reload

→ Same as above. Verify dbGet returns the shape you expect.

Blocked fetch

→ Add @allow host or literal URL. Redeploy.

Timeout at 7s

→ Optimize. Batch DB calls, reduce external fetches.

---

24. Limits Reference

API folder

Limit Value
Files 10 (including _system.js)
Size per file 50 KB
Total size 200 KB
@allow lines per file 20
Unique hosts per project 50
Reserved names index.js, run.js, health.js, whoami.js, files.js, status.js, version.js, robots.js

Runtime

Limit Value
User code timeout 7 seconds
Chromium launch timeout 15 seconds
Page setup timeout 5 seconds
Vercel function max 30 seconds
Response size 5 MB
Request body size 1 MB
Recursion depth 3
Memory 1024 MB

Database

Limit Value
Max size 15 MB
Write rate 100/hour/project
Max batch entries 100
Max value size 2 MB
Forbidden key chars . # $ / [ ]
Transactions None

Secrets

Limit Value
Max value size 16 KB
Max total 512 KB
Max count 50

Rate limits (runtime)

Bucket Max Window
Per session, per route 10 60s
Per session, all routes 50 60s
Per project, all routes 500 1h
Per project, all routes 2,000 24h
Per project, per route 100 1h

Rate limits (hosting API)

Each action has its own limit — see RATE_LIMITS in api/host.js. Notable:

Action Max Window
deploy 10 1h
redeploy 10 1h
secrets/set 20 1h
db/set 300 1m
db/get 600 1m
hosts/add 30 1h

Deployments

Limit Value
Deployments kept 5
Version snapshots per deploy 1

---

25. Security Model

What's private

· api/*.js files — never served over HTTP. Only executed via /api/run.
· Private secrets — appear only in ENV, never in window.__SECRETS__.
· Passwords — hashed with SHA-256(salt | password | salt). The salt is never stored with the hash.
· Session tokens — HMAC-signed, no server-side session store, expire after TTL.

What's public by default

· files/{pid} — served at /{username}/project/{slug}/{path} if visibility.liveSite is public.
· Public secrets — injected into HTML as window.__SECRETS__ only if injection is enabled and the secret is marked public.

Attack surface

Vector Mitigation
Brute-force login 10 attempts / 15 min per email
Brute-force registration 5 attempts / hour per email
Password hash cracking Two-stage salt; salt never stored with hash
Session forgery HMAC with SESSION_SECRET
Session hijacking Bearer token over HTTPS only
Host exfiltration 4-tier allowlist + DNS + HTTPS validation
SQL injection None — no SQL
Path traversal in serving isValidRoutePath blocks ../, %2e%2e
XSS in served HTML Content is the user's own; no escaping needed
DoS via huge responses MAX_RESPONSE_BYTES = 5 MB
DoS via slow scripts 7s timeout
Recursive API calls Depth limit of 3
Secret leakage Secrets never returned unless explicitly public

Sandbox isolation

Each invocation:

· Runs in a fresh Chromium instance — no shared state between calls
· Runs at about:blank origin — cannot access cookies or localStorage from the parent domain
· Has network requests intercepted — only allowlisted hosts reachable
· Has fetch calls to /api/host?action=db/… handled in-process (no network)

This means a malicious script cannot:

· Read another project's data
· Access Folio's own session tokens
· Reach arbitrary external hosts
· Persist state between calls

What a malicious script can do

· Use up its own project's rate limits
· Consume its own project's DB storage
· Return any content it wants to its own callers

It cannot affect other projects, other users, or the Folio platform.

---

26. Best Practices

Structure

· Keep api/*.js focused. One file per domain — notes.js, auth.js, payments.js. Don't put everything in index.js.
· Return an object, not undefined. Wrap in try/catch. Return a fallback at the bottom.
· Guard every env var. if (!ENV.KEY) return { __status: 500, ... }.
· Use db/batch for multi-path writes — one round trip instead of N.

Performance

· Batch DB operations. Each db/set is a separate fetch to host.js. Batch them into one db/batch.
· Cache within one invocation. If you read a project record twice in a call, cache it locally.
· Avoid unnecessary external fetches. Each adds latency. Bulk calls when possible.
· Accept cold starts. First call after a deploy is 1.5–2s. Warm calls are sub-500ms.

Security

· Never expose secrets. Return Object.keys(ENV) not ENV when debugging.
· Always hash passwords. Use the pure-JS SHA-256 implementation. Never store plaintext.
· Verify tokens server-side. Don't trust REQ.headers.authorization from the frontend — re-verify the token inside your script.
· Rate-limit login. 10 attempts per 15 minutes per email.
· Use @allow for hosts you don't recognize. Even if auto-detection finds a URL, explicit @allow is easier to audit.

Reliability

· Handle null bodies. REQ.body may be {} on GET. Guard before destructuring.
· Wrap everything in try/catch. Return a clean error, not a crash.
· Log errors. console.error is not visible — return errors in the response body so they land in apiLogs.
· Test both URL shapes. Friendly and direct should behave identically.

Debugging

· Use the API tab. Recent calls tell you everything.
· Quote X-Request-Id when reporting bugs.
· Add a __debug action to your script for inspection:

```javascript
if (action === "__debug") {
  return {
    envKeys: Object.keys(ENV),
    pid: ENV.PROJECT_ID,
    hasToken: !!(REQ.headers.authorization),
    body: REQ.body,
  };
}
```

· Check the response headers. X-Fetch-Hosts tells you which hosts your script actually reached.

---

27. Troubleshooting Reference

Deploy fails

Symptom Cause Fix
Invalid file Bad path or reserved name Check file naming rules
Too many files 10 API files Remove unused files
File too large 50 KB per file Split, minify, or trim
Unknown owner Session stale Re-login
Host validation failed Detected host can't resolve Remove the URL or add @allow
Too many hosts 50 unique hosts Trim

Runtime fails

Symptom Cause Fix
null response Script returned undefined Wrap in try/catch, return fallback
Function threw an error Uncaught exception Check errorName in logs
Function timed out 7s Optimize; check stage in logs
Route not found File missing or not deployed Redeploy, check apiRoutes
Blocked fetch Host not allowed Add @allow, redeploy
Failed to parse URL Relative URL in sandbox Use ${ENV.FOLIO_BASE_URL}/…
crypto.randomUUID is not a function Secure context needed Use crypto.getRandomValues
crypto.subtle is undefined Secure context needed Use pure-JS SHA-256
Recursion depth exceeded Self-referencing API Inline the logic

Data fails

Symptom Cause Fix
Form doesn't appear after reload db/list shape mismatch Use db/get and walk the tree
DB writes don't persist Wrong pid Check ENV.PROJECT_ID
db/set returns 400 Missing key or data Check payload
db/set returns 403 Missing API key or wrong role Check auth
Response looks like "null" Script returned undefined Add fallback return
Data appears but doesn't load in UI Frontend expects a different shape Compare db/get response to what the UI reads

Auth fails

Symptom Cause Fix
Sign in first on every call Token not sent Include Authorization: Bearer <token>
Session expired Token > 30 days or password changed Re-login
Invalid credentials Wrong password or email Check hash comparison
Password hashing failed crypto.subtle missing in sandbox Use pure-JS SHA-256
Missing PASSWORD_SALT Env not set Add to Secrets tab
Missing SESSION_SECRET Env not set Add to Secrets tab

Image/media fails

Symptom Cause Fix
Picsum/Unsplash blocked Host not in trusted tier Add to TRUSTED_IMAGE_HOSTS in run.js, or add @allow in script
Image URL returns 404 External host doesn't serve that path Check URL manually
Image not loading in HTML CSP or injection issue Check injection toggle in Secrets tab

Hosting fails

Symptom Cause Fix
Page 404 after deploy Wrong path or visibility Check visibility.liveSite
Assets don't load Relative URL rewriting Use paths relative to index.html
Not found from serve Path starts with api/ API files are never served — call via /api/run
HTML renders blank JS error Open browser console
Live URL missing Deploy didn't complete Check deployment.url in dashboard

Rate limiting

Symptom Cause Fix
Rate limit exceeded on normal use Hit per-route limit Wait 60s
Rate limit on every call Per-project limit Wait an hour or check your script
Anonymous limits too tight No session Sign in for per-user limits
Retry-After header Rate limited Respect it

---

Appendix A — The Complete Request Lifecycle

```
Client                    Vercel                    Firebase
  │                         │                         │
  │ POST /{user}/project/   │                         │
  │   {slug}/api/notes      │                         │
  │────────────────────────>│                         │
  │                         │                         │
  │                         │ 1. Rewrite to run.js    │
  │                         │──────────────────────>  │
  │                         │                         │
  │                         │ 2. Parse query params   │
  │                         │                         │
  │                         │ 3. Resolve slug → pid   │
  │                         │─────────────────────────│
  │                         │<────────────────────────│
  │                         │                         │
  │                         │ 4. Auth (verify session)│
  │                         │                         │
  │                         │ 5. Rate limit           │
  │                         │─────────────────────────│
  │                         │<────────────────────────│
  │                         │                         │
  │                         │ 6. Load project, route  │
  │                         │─────────────────────────│
  │                         │<────────────────────────│
  │                         │                         │
  │                         │ 7. Load script          │
  │                         │─────────────────────────│
  │                         │<────────────────────────│
  │                         │                         │
  │                         │ 8. Parse @allow hosts   │
  │                         │                         │
  │                         │ 9. Build ENV (secrets)  │
  │                         │─────────────────────────│
  │                         │<────────────────────────│
  │                         │                         │
  │                         │ 10. Build REQ           │
  │                         │                         │
  │                         │ 11. Launch Chromium     │
  │                         │  (1.5–2s cold)          │
  │                         │                         │
  │                         │ 12. Execute script      │
  │                         │  (max 7s)               │
  │                         │   ├─ fetch /api/host    │
  │                         │   │  ?action=db/...     │
  │                         │   │  (in-process)       │
  │                         │   │                     │
  │                         │   └─ fetch external     │
  │                         │      (if allowed)       │
  │                         │─────────────────────────│
  │                         │<────────────────────────│
  │                         │                         │
  │                         │ 13. Serialize response  │
  │                         │                         │
  │                         │ 14. Log to apiLogs      │
  │                         │─────────────────────────│
  │                         │<────────────────────────│
  │                         │                         │
  │ Response                │                         │
  │<────────────────────────│                         │
```

---

Appendix B — Complete Example: Chat App with OpenAI

api/chat.js:

```javascript
// @allow api.openai.com

const key = ENV.OPENAI_API_KEY;
if (!key) return { __status: 500, error: "OPENAI_API_KEY not configured" };

const message = String(REQ.body?.message || "").slice(0, 1000);
if (!message) return { __status: 400, error: "Message required" };

const r = await fetch("https://api.openai.com/v1/chat/completions", {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "Authorization": "Bearer " + key,
  },
  body: JSON.stringify({
    model: "gpt-4o-mini",
    messages: [{ role: "user", content: message }],
  }),
});

if (!r.ok) {
  return { __status: 502, error: "OpenAI returned " + r.status };
}

const data = await r.json();
const reply = data.choices?.[0]?.message?.content || "";

return { reply };
```

index.html:

```html
<!DOCTYPE html>
<html>
<body>
  <div id="messages"></div>
  <input id="input" placeholder="Type a message">
  <button onclick="send()">Send</button>
  <script>
    async function send() {
      const message = document.getElementById("input").value;
      if (!message) return;

      const msgEl = document.createElement("div");
      msgEl.textContent = "You: " + message;
      document.getElementById("messages").appendChild(msgEl);

      const res = await fetch("/{username}/project/{slug}/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message }),
      });

      const data = await res.json();
      if (data.error) {
        alert(data.error);
        return;
      }

      const replyEl = document.createElement("div");
      replyEl.textContent = "AI: " + data.reply;
      document.getElementById("messages").appendChild(replyEl);
    }
  </script>
</body>
</html>
```

Add OPENAI_API_KEY to Secrets. Deploy. Chat works.

---

Appendix C — API Response Shapes Reference

Shape Status Content-Type Body
{ success: true, data: {...} } 200 application/json Serialized object
"string" 200 text/plain; charset=utf-8 String
42 200 application/json "42"
null / undefined 200 application/json "null"
{ __status: 404, __body: "x", error: "x" } 404 application/json {"error": "x"}
{ __contentType: "text/html", __body: "<p>Hi</p>" } 200 text/html <p>Hi</p>
{ __status: 400, __body: "Invalid", error: "Invalid" } 400 application/json {"error": "Invalid"}
Throws an error 500 application/json {"success": false, "error": "Function threw an error"}
Times out (>7s) 504 application/json {"success": false, "error": "Function timed out"}

---

Appendix D — Glossary

Term Definition
pid Project ID — unique string like p_1792621314066_57fb8a
slug URL-friendly project name like my-project
friendly URL /{username}/project/{slug}/api/{route} — readable form
direct URL /api/{pid}/{route} — fast form, no lookup
@allow Comment declaring an external host your script can fetch
manifest projects/{pid}/allowedHosts — the list of validated external hosts
sandbox The Chromium page your script runs in — isolated per invocation
headless Chromium Chromium without a visible window — used to run scripts in a browser environment
_system.js Auto-created file providing six system routes
stage One of ~25 checkpoints in the invocation lifecycle, used for timing logs
X-Request-Id Unique per-call identifier, matches Vercel logs and API logs
X-Execution-Time Total milliseconds for the invocation
X-Fetch-Hosts External hosts actually reached by the script
ENV Environment object — reserved vars + user secrets
REQ Request object — body, headers, method, project metadata
FILES Public file list — metadata, not contents
__RESULT__ The runtime's internal result object — set by your script's return
__status Override key for HTTP status
__contentType Override key for Content-Type
__body Override key for the response body
@sparticuz/chromium-min The Chromium distribution used in the sandbox
PASSWORD_SALT Env var used as a pepper for password hashing
SESSION_SECRET Env var used to HMAC-sign session tokens

---

<div align="center">

<img src="https://foliostudios.vercel.app/icons/icon-192.png" alt="Folio" width="56" height="56">

Build from anywhere.

Write your code. Test your ideas. Ship your projects.

</div>