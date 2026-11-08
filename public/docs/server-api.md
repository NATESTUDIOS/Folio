The Folio API Playbook

Everything you need to build, deploy, debug, and maintain an api/*.js script on Folio.

This is the complete reference. Every section is self-contained — you can jump to what you need. The last section is a troubleshooting index that maps every symptom to the fix.

---

Table of contents

Part 1 — Concepts

1. What a Folio API is
2. The runtime model
3. How a request travels

Part 2 — Building

4. Your first route
5. Route discovery and URL shapes
6. The three globals: REQ, ENV, FILES
7. Returning responses
8. Reading request data
9. Errors and status codes

Part 3 — Integrations

10. The JSON database
11. Secrets (ENV)
12. External APIs with @allow
13. CDN imports
14. Authentication patterns
15. The _system.js file
16. Crypto, hashing, and secure contexts

Part 4 — Operating

17. The runtime in production
18. API logs
19. Limits and quotas
20. Cold starts and maxDuration

Part 5 — Debugging

21. The debug workflow
22. Common errors → fixes
23. Symptom index

Part 6 — Best practices

24. Project layout
25. Security checklist
26. Deployment checklist

---

Part 1 — Concepts

1. What a Folio API is

Every Folio project can contain JavaScript files in an api/ folder. Each .js file becomes an HTTP route. Deploy the project, call the route, get a response.

There is no framework, no build step, no server to configure, and no package manager. You write a .js file, deploy, and it responds to HTTP requests.

The script runs inside an isolated Chromium sandbox on Vercel's serverless infrastructure. That means the full browser environment is available: fetch, crypto, TextEncoder, Blob, atob/btoa, Intl, Date, Math, JSON, and every other standard API. If it works in Chrome, it works in your script.

The backend is entirely private. api/*.js files are never served over HTTP to the public — they're only executed when called. A visitor to your project's live site can't read your backend code, download it, or see its source. They can only call it and receive whatever it returns.

2. The runtime model

```
┌─────────────┐   1. HTTP request     ┌──────────────────┐
│   Browser   │ ──────────────────────▶│  Vercel rewrite  │
└─────────────┘                        └──────────────────┘
                                              │
                                              ▼
┌─────────────┐                        ┌──────────────────┐
│  User code  │◀── 4. execute ─────────│   api/run.js     │
│ (api/*.js)  │                        │  (the runtime)   │
└─────────────┘                        └──────────────────┘
       │                                      │
       │ 5. return a value                    │ 2. resolve project
       ▼                                      │ 3. launch Chromium
┌─────────────┐                        ┌──────────────────┐
│  JSON DB    │                        │  Firebase RTDB   │
│ (project    │◀── internal fetch ─────│  (api-files,     │
│  data)      │                        │   projects, ...) │
└─────────────┘                        └──────────────────┘
```

The runtime's job:

1. Receive the HTTP request.
2. Resolve {username, project} → pid.
3. Load api-files/{pid}/notes.js (or the requested route).
4. Launch Chromium, inject REQ/ENV/FILES, execute the script.
5. Read back whatever the script returned.
6. Send it to the HTTP response.

Your script's job: read REQ, do something, return a value.

3. How a request travels

Take POST /fortune/project/dynamic-notes/api/notes?action=register:

1. Vercel matches vercel.json's rewrite:
   ```json
   { "source": "/:username/project/:projectname/api/:route",
     "destination": "/api/run?username=:username&project=:projectname&route=:route" }
   ```
   Which produces /api/run?username=fortune&project=dynamic-notes&route=notes&action=register.
2. run.js parses req.query. It sees username=fortune, project=dynamic-notes, route=notes, action=register.
3. Slug resolution: resolveProjectBySlug("fortune", "dynamic-notes") → p_1793827518396_b919f6.
4. Route validation: loadInvocationContext(pid, "notes") reads projects/{pid}/apiRoutes.user → ["notes"]. Confirmed as a user route.
5. File loading: loadRouteFile(pid, "notes", false) reads api-files/{pid}/notes.js or api-files/{pid}/api__notes.js.
6. Rate limit: 5 buckets checked (per session per route, per session all routes, per project per hour, per project per day, per project per route per hour).
7. ENV building: projectSecrets.readAllSecrets(pid) + reserved env vars → merged into a env object.
8. HTML build: a self-contained document with <script>window.ENV = ...; window.FILES = ...; window.REQ = ...;</script> followed by <script type="module">(async () => { /* your script */ })();</script>.
9. Chromium launch: @sparticuz/chromium-min extracts its pack, then puppeteer.launch() starts the browser.
10. Page execution: page.setContent(html) loads the page. The script executes. When it finishes (or throws), window.__RESULT__ is set.
11. Result read: page.evaluate(() => window.__RESULT__) returns { ok, status, contentType, body }.
12. Response sent: run.js sets the HTTP status, Content-Type, and body from the script's return.
13. Cleanup: browser closed, log entry written, metrics recorded.

Total round trip: ~700ms warm, ~2-5s cold. The 30s maxDuration covers one cold start plus script execution.

---

Part 2 — Building

4. Your first route

Create a file called api/hello.js:

```javascript
return { message: "Hello from the server!" };
```

That's the entire file. No module.exports, no res.send, no function wrapper. Whatever your script returns becomes the response body.

Deploy the project. Then call the route:

```bash
curl -X POST 'https://foliostudios.vercel.app/{username}/project/{slug}/api/hello'
```

Response:

```json
{"message":"Hello from the server!"}
```

You just wrote a working API endpoint.

5. Route discovery and URL shapes

Every api/*.js file becomes a route named after the file (without .js).

File Route
api/hello.js hello
api/chat.js chat
api/notes-v2.js notes-v2
api/users/create.js Invalid — no subfolders

Two URL shapes per route:

Friendly URL (preferred)

```
POST /{username}/project/{slug}/api/{route}
```

Reads naturally, shareable, this is what you document.

Direct URL (fast-path)

```
POST /api/{pid}/{route}
```

Skips the slug→pid lookup on the first call. Identical behavior otherwise.

Calling from your frontend

```javascript
// Friendly URL
const res = await fetch(`/${username}/project/${slug}/api/hello`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ name: "Alice" }),
});

// Direct URL — same behavior
const res = await fetch(`/api/${PID}/hello`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ name: "Alice" }),
});
```

Route discovery via the API

```bash
curl 'https://foliostudios.vercel.app/api/host?action=api-routes&pid=YOUR_PID' \
  -H 'Authorization: Bearer YOUR_SESSION_TOKEN'
```

Returns:

```json
{
  "success": true,
  "system": ["health", "whoami", "files", "status", "version", "robots"],
  "user": ["notes", "chat"],
  "friendlyBaseUrl": "https://foliostudios.vercel.app/{username}/project/{slug}/api",
  "directBaseUrl": "https://foliostudios.vercel.app/api/YOUR_PID",
  "maxFiles": 10
}
```

6. The three globals: REQ, ENV, FILES

Every script has access to three variables, injected by the runtime before your code runs.

REQ — the incoming request

Field Type Description
REQ.method string "GET", "POST", etc.
REQ.body object Parsed JSON body. {} if none.
REQ.query object Query string parameters
REQ.headers object "content-type", "user-agent", "authorization"
REQ.route string Route name — "hello" for api/hello.js
REQ.pid string Your project ID
REQ.username string\|null Owner's username
REQ.projectSlug string\|null Project's URL slug
REQ.projectName string\|null Display name
REQ.deployedAt number\|null Timestamp of current deployment
REQ.deploymentId string\|null Current deployment ID
REQ.versionId string\|null Current version ID
REQ.deploymentUrl string\|null Live URL for this deployment
REQ.region string Vercel region — "iad1"
REQ.publicFileCount number Count of public files
REQ.publicFileList array Full public file list

REQ.body and REQ.query are frozen — read them, don't mutate.

ENV — your secrets and reserved variables

A frozen object with every secret from the Secrets tab, plus a set of reserved variables injected by the runtime:

Variable Value
ENV.PROJECT_ID Your project ID
ENV.PROJECT_NAME Display name
ENV.PROJECT_SLUG URL slug
ENV.PROJECT_URL Clean project URL
ENV.OWNER_USERNAME Owner's username
ENV.OWNER_UID Owner's UID
ENV.DEPLOYMENT_ID Current deployment ID
ENV.DEPLOYMENT_URL Current deployment URL
ENV.FOLIO_BASE_URL https://foliostudios.vercel.app
ENV.FOLIO_API_URL https://foliostudios.vercel.app/api
ENV.API_ROUTE Current route name
ENV.REQUEST_ID Unique ID for this invocation

ENV is per-invocation, built fresh. You can't cache it across calls.

FILES — the public file list

```javascript
{
  files: [
    { path: "index.html", bytes: 4821, type: "text/html; charset=utf-8" },
    { path: "app.js", bytes: 26469, type: "application/javascript; charset=utf-8" }
  ],
  count: 2,
  totalBytes: 31290
}
```

Useful for building manifests, sitemaps, or file listings.

7. Returning responses

Whatever your script returns becomes the response body. Four patterns:

1. JSON (default)

```javascript
return { ok: true, message: "Hello" };
```

Response: {"ok":true,"message":"Hello"} with Content-Type: application/json.

2. Plain text

```javascript
return "Hello, world!";
```

Response: Hello, world! with Content-Type: text/plain; charset=utf-8.

3. Custom status and content type

```javascript
return {
  __status: 404,
  __contentType: "text/plain; charset=utf-8",
  __body: "Not found",
};
```

Special key Purpose
__status HTTP status code. Default 200.
__contentType Content-Type header. Default application/json.
__body Response body. String or object.

If your return object has any of these keys, the runtime treats it as a special response envelope. Otherwise, the whole return value becomes the JSON body.

4. Errors — prefer explicit returns

```javascript
if (!REQ.body.name) {
  return { __status: 422, ok: false, error: "name is required" };
}
```

Throwing also works, but the caller only sees the generic "Function threw an error" message:

```javascript
throw new Error("Something broke");
```

Response:

```json
{ "success": false, "error": "Function threw an error", "route": "hello" }
```

The actual error message goes to Vercel logs, not the caller. For user-facing errors, return an explicit errorResponse object.

8. Reading request data

Query string

```
POST /api/{pid}/hello?name=Alice
```

```javascript
const name = REQ.query.name;   // "Alice"
```

Body

```bash
curl -X POST ... -H 'Content-Type: application/json' \
  -d '{"name":"Alice"}'
```

```javascript
const name = REQ.body.name;   // "Alice"
```

The runtime parses JSON bodies automatically. Non-JSON bodies arrive as {}.

Headers

```javascript
const auth = REQ.headers.authorization;    // "Bearer abc..."
const ua = REQ.headers["user-agent"];      // "Mozilla/5.0..."
const ct = REQ.headers["content-type"];    // "application/json"
```

9. Errors and status codes

Status Meaning When to use
200 OK Successful read or update
201 Created After a successful create
400 Bad request Missing required field
401 Unauthorized No or invalid auth token
403 Forbidden Authenticated but not allowed
404 Not found Resource doesn't exist
409 Conflict Duplicate (e.g. username taken)
413 Payload too large Body or response exceeds limit
422 Unprocessable Validation failed
429 Rate limited Too many requests
500 Server error Unhandled exception
504 Timeout Script exceeded 7s

Pattern for consistency:

```javascript
function ok(data, status = 200) {
  return { __status: status, ok: true, ...data };
}

function fail(message, status = 400, extra = {}) {
  return { __status: status, ok: false, error: message, ...extra };
}

if (!REQ.body.name) return fail("name is required", 422);
```

---

Part 3 — Integrations

10. The JSON database

Every project has a per-project JSON store, up to 15 MB, backed by Firebase Realtime Database.

Reading

```javascript
const res = await fetch("/api/host?action=db/get&pid=" + ENV.PROJECT_ID);
const { data } = await res.json();
return { users: data.users || {} };
```

The response is:

```json
{
  "success": true,
  "data": { /* your entire project DB */ },
  "schema": null,
  "space": { "used": 1234, "limit": 15728640, "percentUsed": 0.01 }
}
```

Writing — three modes

Path write — update one key, preserve siblings:

```javascript
await fetch("/api/host?action=db/set", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    pid: ENV.PROJECT_ID,
    key: "users/u_abc/name",
    value: "Alice"
  }),
});
```

Batch write — multiple paths atomically:

```javascript
await fetch("/api/host?action=db/batch", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    pid: ENV.PROJECT_ID,
    updates: [
      { key: "users/u_abc", value: { name: "Alice", role: "admin" } },
      { key: "counters/admins", value: 1 },
    ]
  }),
});
```

Merge mode — replace top-level subtrees:

```javascript
await fetch("/api/host?action=db/set", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    pid: ENV.PROJECT_ID,
    data: { config: { theme: "dark" } },
    mode: "merge"
  }),
});
```

⚠️ Merge is not deep. Sending config: { theme } replaces the entire config subtree. It does not update only config.theme.

Batch write rules

db/batch validates before writing. Two invariants:

1. No duplicate keys. Two entries with the same key fail with "Duplicate key in batch".
2. No parent + child in the same batch. users/u_abc and users/u_abc/name in the same batch fail with "Cannot write to a parent of a key".

Wrong:

```javascript
updates: [
  { key: "notes/n_1", value: { title: "Hello" } },
  { key: "notes/n_1/preview", value: "..." }  // ← parent/child collision
]
```

Right:

```javascript
updates: [
  { key: "notes/n_1", value: { title: "Hello", preview: "..." } }
]
```

Wrong:

```javascript
updates: [
  { key: "noteBodies/n_1", value: { markdown: "..." } },
  { key: "noteBodies/n_1", value: { extras: {} } }  // ← duplicate key
]
```

Right:

```javascript
updates: [
  { key: "noteBodies/n_1", value: { markdown: "...", extras: {} } }
]
```

Limits

Limit Value
Max size per project 15 MB
Max size per write 2 MB
Max batch entries 100
Max key depth Firebase allows arbitrarily deep; Folio caps at 10 path segments
Arrays Firebase doesn't support arrays — they become {"0": ..., "1": ...}
null values Deleting a key is value: null

11. Secrets (ENV)

Store API keys, tokens, and credentials in the project's Secrets tab. They're encrypted at rest and never sent to the browser.

Accessing from api/*.js

```javascript
const key = ENV.OPENAI_API_KEY;
```

Visibility

Visibility Available in api/*.js Injected into HTML
private (default) ✅ ❌
public ✅ ✅ window.__SECRETS__

Use public only for publishable keys (Stripe publishable, Supabase anon). Never for server keys.

Reserved names

You can't create a secret with any of these names — they're auto-injected:

PROJECT_ID, PROJECT_NAME, PROJECT_SLUG, PROJECT_URL, OWNER_USERNAME, OWNER_UID, DEPLOYMENT_ID, DEPLOYMENT_URL, FOLIO_BASE_URL, FOLIO_API_URL, API_ROUTE, REQUEST_ID, FOLIO_API_KEY

Limits

Limit Value
Max value size 16 KB
Max total per project 512 KB
Max count 50

12. External APIs with @allow

By default, only six hosts are reachable: api.openai.com, api.groq.com, api.anthropic.com, api.stripe.com, api.supabase.co, api.resend.com.

To reach anything else, declare it at the top of your file:

```javascript
// @allow api.weather.com
// @allow api.example.com

const weather = await fetch("https://api.weather.com/v1/today");
return await weather.json();
```

Rules

· HTTPS only.
· Hostname only. No https://, no paths, no ports, no wildcards.
· No IP addresses. 10.0.0.5 is rejected.
· No Folio infrastructure. *.vercel.app is blocked.
· Must respond to HTTPS. If it doesn't, the deploy is rejected.
· Max 20 @allow lines per file.
· Max 50 unique hosts per project.

Validation timing

@allow hosts are validated at deploy time, not at runtime. When you deploy:

1. run.js extracts all @allow hosts across all files
2. Each host is DNS-resolved (rejects private IPs, localhost, reserved ranges)
3. Each host is tested for HTTPS reachability
4. All hosts are stored in projects/{pid}/allowedHosts for runtime reference

If validation fails, the entire deploy is rejected with a list of violations.

Runtime behavior

If you call an undeclared host, the request is blocked with a 403 — the fetch fails before it leaves the sandbox.

13. CDN imports

You can import from three CDNs directly:

```javascript
import { marked } from "https://cdn.jsdelivr.net/npm/marked@12/marked.esm.js";

const html = marked(REQ.body.markdown);
return { html };
```

CDN URL prefix
jsDelivr https://cdn.jsdelivr.net/npm/
esm.sh https://esm.sh/
unpkg https://unpkg.com/

Imports are resolved at module load time. They're blocked from any other host.

14. Authentication patterns

The runtime does not require authentication. Whether a route is public or protected is your choice.

Public routes

register, login, public-get — no token needed. Just handle the request and return.

```javascript
if (action === "register") {
  return await handleRegister(REQ.body);
}
```

Protected routes

Require a bearer token in the Authorization header. The runtime forwards REQ.headers.authorization from the HTTP request to your script.

```javascript
async function requireAuth() {
  const auth = REQ.headers?.authorization;
  if (!auth) throw { status: 401, message: "Not authenticated" };

  const token = auth.replace(/^Bearer\s+/i, "").trim();
  if (token.length < 32) throw { status: 401, message: "Invalid token" };

  const data = await dbRead();
  const tokenHash = sha256(token);

  for (const [uid, user] of Object.entries(data.users || {})) {
    if (user?.tokenHash === tokenHash) return { uid, ...user };
  }
  throw { status: 401, message: "Not authenticated" };
}
```

Pattern: bearer token issued at login

```javascript
function randomToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  return Array.from(bytes).map(b => b.toString(16).padStart(2, "0")).join("");
}

async function handleLogin(body) {
  const data = await dbRead();
  const uid = data.usernames?.[body.username.toLowerCase()];
  if (!uid) return fail("No account found", 404);

  const token = randomToken();
  const tokenHash = sha256(token);

  await dbWrite(`users/${uid}/tokenHash`, tokenHash);

  return ok({ uid, username: data.users[uid].username, token });
}
```

Client stores token in localStorage, sends Authorization: Bearer {token} on every protected call.

Pattern: project API key

Every project has an API key (generate in Settings → API key). It's stored in ENV.FOLIO_API_KEY if generated through the dashboard.

To allow key-based auth:

```javascript
async function requireApiKeyOrAuth() {
  const auth = REQ.headers?.authorization || "";
  if (auth.startsWith("Bearer ")) {
    const token = auth.slice(7).trim();
    if (token === ENV.FOLIO_API_KEY) return { uid: null, via: "api-key" };
  }
  // ...fall through to session-token auth
}
```

---

15. The _system.js file

Every project gets a _system.js file auto-created on first deploy. It provides six routes for free:

Route Returns
health { status, pid, deployed, responseMs }
whoami { pid, name, deployedAt, apiVersion }
files { files, count, totalBytes }
status { status, pid, deployed, responseMs, region, runtime, apiFiles, publicFiles, lastError, lastErrorAt }
version { deploymentId, deployedAt, versionId, gitCommit, url }
robots Plain-text robots.txt

They're non-deletable, editable, and revertible. Use them to verify the runtime is healthy or to read project metadata without writing your own route.

They don't appear in the user file list. _system.js is infrastructure. It lives in api-files/{pid}/ but the Code tab hides it.

16. Crypto, hashing, and secure contexts

The Chromium sandbox created by run.js uses page.setContent(), which produces an about:blank page. about:blank is not a secure context.

Consequences:

API Works in sandbox? Why
crypto.getRandomValues() ✅ Available everywhere
crypto.randomUUID() ✅ Available everywhere
crypto.subtle.digest() ❌ Secure-context only
crypto.subtle.encrypt() ❌ Secure-context only
crypto.subtle.sign() ❌ Secure-context only

If you try to call crypto.subtle.digest(), it throws:

```
TypeError: Cannot read properties of undefined (reading 'digest')
```

The fix: use inline SHA-256

For hashing, ship a synchronous implementation. This is what notes.js does — an inline SHA-256 that doesn't need crypto.subtle.

```javascript
function sha256(str) {
  const K = [
    0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,
    0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,
    0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,
    0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,
    0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,
    0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,
    0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,
    0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2,
  ];
  const H = [0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19];

  const bytes = new TextEncoder().encode(str);
  const bitLen = bytes.length * 8;
  const padLen = (bytes.length + 8 + 64) & ~63;
  const buf = new Uint8Array(padLen);
  buf.set(bytes);
  buf[bytes.length] = 0x80;
  const view = new DataView(buf.buffer);
  view.setUint32(padLen - 4, bitLen >>> 0, false);
  view.setUint32(padLen - 8, Math.floor(bitLen / 0x100000000), false);

  const W = new Uint32Array(64);
  const rotr = (x, n) => (x >>> n) | (x << (32 - n));

  for (let offset = 0; offset < padLen; offset += 64) {
    for (let i = 0; i < 16; i++) W[i] = view.getUint32(offset + i * 4, false);
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(W[i - 15], 7) ^ rotr(W[i - 15], 18) ^ (W[i - 15] >>> 3);
      const s1 = rotr(W[i - 2], 17) ^ rotr(W[i - 2], 19) ^ (W[i - 2] >>> 10);
      W[i] = (W[i - 16] + s0 + W[i - 7] + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, h] = H;
    for (let i = 0; i < 64; i++) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const t1 = (h + S1 + ch + K[i] + W[i]) >>> 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + maj) >>> 0;
      h = g; g = f; f = e; e = (d + t1) >>> 0;
      d = c; c = b; b = a; a = (t1 + t2) >>> 0;
    }
    H[0] = (H[0] + a) >>> 0; H[1] = (H[1] + b) >>> 0;
    H[2] = (H[2] + c) >>> 0; H[3] = (H[3] + d) >>> 0;
    H[4] = (H[4] + e) >>> 0; H[5] = (H[5] + f) >>> 0;
    H[6] = (H[6] + g) >>> 0; H[7] = (H[7] + h) >>> 0;
  }
  return H.map(x => x.toString(16).padStart(8, "0")).join("");
}
```

For HMAC, PBKDF2, or other crypto operations, either:

1. Ship inline implementations (there are plenty on npm for copy-paste)
2. Call a /api/host action if Folio provides one
3. Use crypto.subtle in the browser (frontend) and pass results to the backend

---

Part 4 — Operating

17. The runtime in production

Latency

Scenario Expected duration
Warm container, simple script 500-700ms
Warm container, script with external fetch 700-1500ms
Cold container, simple script 2000-5000ms
Cold container, script with external fetch 3000-8000ms

Cold starts happen after ~15 minutes of inactivity. Vercel recycles the container.

Chromium

The runtime launches Chromium per invocation. @sparticuz/chromium-min extracts a Chromium pack to /tmp on first use, then reuses it for subsequent calls in the same container.

Do not override LD_LIBRARY_PATH — chromium-min sets it correctly. Overriding it with path.dirname(executablePath) breaks the library loader.



