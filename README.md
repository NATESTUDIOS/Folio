<div align="center">

<img src="https://foliostudios.vercel.app/icons/icon-192.png" alt="Folio Logo" width="100" height="100">

Folio

Code in your pocket.

A mobile-first, offline-first code editor built for the way you code.

Write, preview, manage, and deploy websites directly from your phone. No
desktop setup. No build step. No account required to get started.

<https://img.shields.io/badge/OPEN-FOLIO-F59E0B?style=for-the-badge&logo=googlechrome&logoColor=white>
<https://img.shields.io/badge/READ-DOCS-3B82F6?style=for-the-badge>
<https://img.shields.io/badge/PWA-INSTALLABLE-10B981?style=for-the-badge>

Website · Documentation · Report a bug

</div>

------------------------------------------------------------------------

# Overview

Folio is a browser-based development environment that makes building
websites practical on mobile devices.

It combines a code editor, file manager, live preview, version
snapshots, project hosting, a private server-side API runtime, and a
built-in JSON database in one lightweight workspace.

Projects are stored locally first, so you can keep working when your
internet connection disappears. When you're ready to publish, deploy
your project to a live URL and share it with anyone.

**Start locally. Work offline. Publish when you're ready.**

## At a glance

| Capability             | What it means                                                             |
|------------------------|---------------------------------------------------------------------------|
| Mobile-first           | Designed for touchscreens and small displays                              |
| Offline-first          | Local projects remain available without internet                          |
| Live preview           | See your code run without a build step                                    |
| One-tap deployment     | Publish projects to a live URL                                            |
| Private API runtime    | Write server-side JavaScript in `api/*.js` and call it from your frontend |
| Built-in JSON database | Add simple dynamic data to your projects                                  |
| User accounts          | Email + password sign-in with hashed passwords                            |
| AI assistant           | Explain, fix, and draft code through staged proposals                     |
| Collaboration          | Invite people with different project permissions                          |
| Version history        | Save snapshots and restore earlier work                                   |
| No-account entry       | Start coding before signing in                                            |

<div align="center">

Your development workspace, wherever you are.

<img src="https://foliostudios.vercel.app/screenshots/screenshot1.png" alt="Folio code editor" width="260">

</div>

------------------------------------------------------------------------

# Screenshots

<div align="center">

**Code editor**

<img src="https://foliostudios.vercel.app/screenshots/screenshot1.png" alt="Code editor with syntax highlighting" width="300">

**Project library**

<img src="https://foliostudios.vercel.app/screenshots/screenshot2.png" alt="Folio project library" width="300">

**Live preview**

<img src="https://foliostudios.vercel.app/screenshots/screenshot3.png" alt="Website rendered in Folio preview" width="300">

**Deployments**

<img src="https://foliostudios.vercel.app/screenshots/screenshot4.png" alt="Project deployments dashboard" width="300">

**JSON database**

<img src="https://foliostudios.vercel.app/screenshots/screenshot5.png" alt="Folio JSON database interface" width="300">

**AI Lens**

<img src="https://foliostudios.vercel.app/screenshots/screenshot6.png" alt="Folio AI Lens panel" width="300">

</div>

------------------------------------------------------------------------

# Features

## 01. A real code editor

Write and manage code with a development environment designed for
mobile.

- Syntax highlighting for HTML, CSS, JavaScript, TypeScript, JSX/TSX,
  JSON, Markdown, Python, and more.
- Autocomplete and bracket matching.
- Multiple cursors.
- Find text in the current file using Ctrl/Cmd + F.
- Format HTML, CSS, JavaScript, JSON, and Markdown with Prettier.
- Save version snapshots with commit messages.
- Compare versions and restore earlier snapshots.

## 02. Live preview

- Full-screen preview, mini panel, or a separate browser tab.
- Multi-file HTML projects with CSS and JavaScript.
- Console output returned to the editor.
- No mandatory compilation or bundling step for ordinary static
  projects.

## 03. One-tap deployment

- Publish projects to a live URL.
- Keep deployment versions and redeploy previous versions.
- Take a deployment offline without deleting your local files.
- Serve project assets and relative URLs through Folio's hosting
  endpoint.

## 04. User accounts

Folio uses email + password authentication backed by Firebase Realtime
Database.

- **Registration** — email, password, confirm. Password must be at least
  8 characters.
- **Login** — email + password, verified against the stored hash.
- **Session tokens** — HMAC-signed, 30-day TTL, stateless.
- **Change password** — requires the current password, invalidates all
  old sessions.
- **Delete account** — cascades: deletes the account, all notes, and all
  versions.
- **Rate limiting** — 10 login attempts per 15 minutes per email; 5
  registrations per hour.

### How passwords are stored

Each password is hashed with a two-stage scheme:

``` text
SHA-256(PASSWORD_SALT + "|" + password + "|" + PASSWORD_SALT)
```

Only the hash is stored. `PASSWORD_SALT` is an environment variable that
never appears in the database or the frontend. If the database is
dumped, an attacker cannot brute-force passwords without also
compromising the server environment.

### How sessions work

On successful register/login, the backend issues a session token:

``` text
base64(userId|expiry).hmac(userId|expiry, SESSION_SECRET)
```

Every authenticated request sends this token as:

``` http
Authorization: Bearer <token>
```

The backend verifies the HMAC and expiry, plus checks
`passwordChangedAt` to reject tokens issued before a password change.

### Where the crypto runs

Folio's runtime is a sandboxed Chromium page at `about:blank`, which is
a non-secure context. That means `crypto.subtle` and `crypto.randomUUID`
are unavailable.

Folio uses pure-JS SHA-256 and HMAC for password hashing and session
signing, and a `crypto.getRandomValues`-based UUID generator, all of
which work in non-secure contexts.

## 05. Private API runtime

Projects can run their own server-side JavaScript — no separate backend
service required.

Write JavaScript in `api/*.js`, deploy, and call it from your frontend.
Every route runs inside an isolated Chromium sandbox on Vercel
serverless functions, so your code gets the full browser environment:
`fetch`, `crypto`, `TextEncoder`, `Date`, standard library, and any CDN
module that's allowlisted.

### What a route can touch

| Object  | Purpose                                                                        |
|---------|--------------------------------------------------------------------------------|
| `REQ`   | The incoming request — body, method, headers, route, pid, and project metadata |
| `ENV`   | Your project's secrets — API keys, tokens — never sent to the browser          |
| `FILES` | The project's public file list, injected at runtime                            |

Anything your script returns becomes the response body. No `res.json`,
no handler boilerplate.

``` javascript
// api/hello.js
return { message: "Hello from the server!" };
```

Call it from your frontend:

``` javascript
const res = await fetch("/{username}/project/{slug}/api/hello", {
  method: "POST"
});
const data = await res.json();
// → { message: "Hello from the server!" }
```

With a request body:

``` javascript
// api/greet.js
const name = REQ.body.name || "friend";
return { greeting: `Hello, ${name}!` };
```

With a secret:

``` javascript
// api/chat.js
const r = await fetch("https://api.openai.com/v1/chat/completions", {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "Authorization": "Bearer " + ENV.OPENAI_API_KEY,
  },
  body: JSON.stringify({
    model: "gpt-4o-mini",
    messages: [{ role: "user", content: REQ.body.message }],
  }),
});
const data = await r.json();
return data.choices[0].message.content;
```

The OpenAI key is read from `ENV` on the server. It never reaches the
browser.

### Two URL shapes per route

| Shape    | Example                                       |
|----------|-----------------------------------------------|
| Friendly | `POST /{username}/project/{slug}/api/{route}` |
| Direct   | `POST /api/{pid}/{route}`                     |

Both resolve to the same invocation. The friendly form is what you
document; the direct form skips the slug lookup on the first call.

### The six system routes

Every project ships with a free `_system.js` that provides six routes
out of the box:

| Route     | Returns                                                                   |
|-----------|---------------------------------------------------------------------------|
| `health`  | `{ status, pid, deployed, responseMs }`                                   |
| `whoami`  | `{ pid, name, deployedAt, apiVersion }`                                   |
| `files`   | `{ files, count, totalBytes }` — the public file list                     |
| `status`  | Richer health info including region, runtime, file counts, and last error |
| `version` | `{ deploymentId, deployedAt, versionId, url }`                            |
| `robots`  | Plain-text robots.txt                                                     |

Auth is your script's decision. The runtime does not require
authentication before executing a script. Your `api/*.js` decides what
needs a token — a register or login route can be fully public, while a
list route can require a bearer token. Rate limits are attributed
per-user when a session token is present, per-IP otherwise.

## 06. Allowed external hosts

Scripts can only reach external hosts that have been explicitly allowed.
Folio has four tiers of trusted hosts so you don't have to declare every
call by hand:

| Tier                 | Where                                   | What it covers                                                                                                                                                                                               |
|----------------------|-----------------------------------------|--------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| Built-in API hosts   | `BUILTIN_ALLOWED_HOSTS` in `run.js`     | `api.openai.com`, `api.groq.com`, `api.anthropic.com`, `api.stripe.com`, `api.paystack.co`, `api.supabase.co`, `api.resend.com`, `api.github.com`, `raw.githubusercontent.com`, `gist.githubusercontent.com` |
| Trusted image hosts  | `TRUSTED_IMAGE_HOSTS` in `run.js`       | `picsum.photos`, `fastly.picsum.photos`, `images.unsplash.com`, `images.pexels.com`, `cdn.pixabay.com`, `upload.wikimedia.org`                                                                               |
| Allowed import hosts | `ALLOWED_IMPORT_HOSTS` in `run.js`      | `cdn.jsdelivr.net`, `esm.sh`, `unpkg.com`, `cdnjs.cloudflare.com`, `ga.jspm.io`, `cdn.skypack.dev`                                                                                                           |
| Per-project hosts    | `projects/{pid}/allowedHosts` in the DB | Anything declared via `// @allow host.name` or auto-detected from literal `https://host/...` URLs in your scripts, or added from the dashboard                                                               |

### Auto-detection

When you deploy, the pipeline scans every `api/*.js` file for:

1.  Explicit `// @allow host.name` or `// @allow-host host.name`
    comments.
2.  Literal `https://host/...` URLs anywhere in the source —
    `fetch("https://...")`, `import ... from "https://..."`, string
    constants.

Every detected host is validated (DNS + HTTPS reachability, reject
private/reserved IPs) and written to `projects/{pid}/allowedHosts`.

If you write:

``` javascript
// api/weather.js
const r = await fetch("https://api.weather.com/v1/today");
return await r.json();
```

…the deploy pipeline automatically allows `api.weather.com`. No `@allow`
comment needed for literal URLs.

### Dynamic URLs still need `@allow`

Folio cannot statically analyze:

``` javascript
const host = REQ.body.host;  // user-controlled
const r = await fetch(`https://${host}/x`);
```

Because the hostname isn't a literal string, the scanner can't detect
it. You must declare the actual hosts explicitly:

``` javascript
// @allow api.example.com
// @allow api.weather.com
```

### Allowing new hosts from the dashboard

Owners can add any public host from the API tab without editing code.
The backend validates DNS + HTTPS before writing to the manifest. Added
hosts persist until removed.

Blocked requests are logged. When a script tries to reach an unallowed
host, `run.js` logs `run.host_blocked` with the hostname. The API tab's
log view shows this, so you can debug "why doesn't my fetch work"
without guessing.

### Runtime limits on the API folder

| Limit                    |                       Value |
|--------------------------|----------------------------:|
| Files per API folder     | 10 (including `_system.js`) |
| Size per file            |                       50 KB |
| Total API folder size    |                      200 KB |
| `@allow` lines per file  |                          20 |
| Unique hosts per project |                          50 |
| Execution timeout        |                   7 seconds |
| Response size            |                        5 MB |

The runtime runs on Vercel's Node.js serverless functions with Chromium
for the sandbox. Cold starts are 1.5–2s on the free tier; warm calls are
sub-500ms for typical scripts.

## 07. Built-in JSON database

Give projects a simple hosted data store without building a database
backend from scratch.

- Read project data through an HTTP API.
- Authenticate writes with a project API key.
- Update individual paths, merge top-level data, or replace the
  database.
- Store configuration, guestbook entries, small collections, feature
  flags, and other lightweight application data.

Default limits: 15 MB per project database and 100 writes per hour per
project.

## 08. AI assistant

Folio includes an AI helper that lives in the editor and dashboard — the
Lens panel.

- 22 tasks across understanding, fixing, building, documenting, and
  diagnosing code.
- Explain, debug, fix, optimize, refactor, document, audit, translate —
  with patch previews you accept or reject.
- Diagrams as Mermaid, mind maps, and flow tables — rendered inline.
- Commit and deploy drafts — the AI drafts text; you approve before
  anything is applied.
- Offline-safe rendering. Markdown, diagrams, math, and diffs render
  locally once the app is cached.
- Nothing is auto-applied. AI drafts live in a staged queue until you
  accept them.

## 09. Sharing and collaboration

- Configure independent visibility settings for your profile, live site,
  code viewer, language information, and JSON database API.
- Invite collaborators as viewers, commenters, or editors.
- Maintain a public profile with a list of projects.
- Share project pages using URLs such as
  `https://foliostudios.vercel.app/<username>/<slug>`.

## 10. Offline-first PWA

- Store projects in IndexedDB before relying on cloud synchronization.
- Install the app from a supported browser.
- Cache the application shell using a cache-first strategy.
- Use stale-while-revalidate caching for eligible assets.
- Prompt users when an updated application version becomes available.
- Queue supported synchronization operations for later processing.

## 11. Export and portability

| Format   | Contents                                                                             |
|----------|--------------------------------------------------------------------------------------|
| `.folio` | Full project backup, including files, versions, JSON database, schema, and API files |
| `.zip`   | Current project files                                                                |
| `.json`  | JSON database data                                                                   |

Import a `.folio` backup to restore a project.

------------------------------------------------------------------------

# Getting started

You can start coding without installing anything.

1.  Open Folio in your browser.
2.  Select **New project**.
3.  Enter a project name and choose an icon.
4.  Open the editor and start writing code.
5.  Use the preview control to run your project.
6.  Sign in when you need cloud synchronization, deployment,
    collaboration, private API runtime, or account-dependent AI
    features.

New projects automatically receive starter files:

``` text
index.html
style.css
app.js
```

## Install Folio on your phone

1.  Open Folio in a supported browser.
2.  Open the browser menu.
3.  Select **Install app** or **Add to Home screen**.
4.  Launch Folio from your home screen.

Installation availability depends on the browser and platform.

------------------------------------------------------------------------

# How Folio works

## The four core panels

| Panel   | Purpose                                                     |
|---------|-------------------------------------------------------------|
| Editor  | Write code, search, format, and manage versions             |
| Files   | Create, rename, and organize project files                  |
| Preview | Run the project and inspect its output                      |
| API     | Manage private server-side routes and inspect system routes |

## Storage architecture

Folio uses browser storage for local work and server storage for
supported cloud features.

| Store         | Purpose                                                        |
|---------------|----------------------------------------------------------------|
| `projects`    | Project metadata — IDs, names, slugs, icons, timestamps, roles |
| `files`       | File contents, keyed by project ID and path                    |
| `versions`    | Version snapshots and commit messages                          |
| `projectMeta` | Project-specific notes and notepad data                        |
| `syncQueue`   | Pending synchronization operations                             |

On the server:

- Public assets → `files/{pid}`
- Private runtime scripts → `api-files/{pid}`
- Accounts → `accounts/{emailKey}` (hashed password + metadata)
- Notes (for the notes project) → `notes/{noteId}`, indexed under
  `userNotes/{userId}/{noteId}`
- Versions → `versions/{noteId}/{timestamp}` (last 3 kept)
- Project host manifest → `projects/{pid}/allowedHosts`

The browser uses IndexedDB for local project data. Server-side project
data is handled by the backend and Firebase Realtime Database.

## How deployment works

Folio stores deployed project files and serves them through a hosting
endpoint.

``` text
https://foliostudios.vercel.app/api/host?action=serve&pid=YOUR_PID&path=index.html
```

The serving handler rewrites supported relative asset references so
files such as `style.css` and `app.js` can be loaded through the hosting
endpoint. This allows ordinary multi-file static projects to work
without a separate build configuration.

------------------------------------------------------------------------

# Environment configuration

Folio needs a small set of environment variables to run. Set them in
Vercel **Project Settings → Environment Variables** or the Secrets tab
of the Folio dashboard (for per-project values).

## Platform variables (Vercel)

| Variable                | Required | Purpose                                                                                                |
|-------------------------|----------|--------------------------------------------------------------------------------------------------------|
| `BASE_URL`              | Yes      | The canonical deployment URL. Used in every generated link. Example: `https://foliostudios.vercel.app` |
| `FIREBASE_PROJECT_ID`   | Yes      | Firebase project ID                                                                                    |
| `FIREBASE_CLIENT_EMAIL` | Yes      | Firebase service account email                                                                         |
| `FIREBASE_PRIVATE_KEY`  | Yes      | Firebase service account private key                                                                   |
| `ADMIN_API_KEY`         | Yes      | Admin key for privileged operations                                                                    |
| `FLIER_INTERNAL_URL`    | Optional | Internal image-generation endpoint                                                                     |
| `GROQ_API_KEY`          | Optional | Enables AI features                                                                                    |
| `GROQ_MODEL`            | Optional | Primary AI model. Example: `llama-3.3-70b-versatile`                                                   |
| `GROQ_MODEL_FAST`       | Optional | Fallback AI model                                                                                      |

## Auth variables

These sign passwords and sessions. Set both before anyone registers.
**Never change `PASSWORD_SALT` after users exist** — changing it
invalidates every stored password.

| Variable         | Required           | Minimum length | Purpose                                                                        |
|------------------|--------------------|---------------:|--------------------------------------------------------------------------------|
| `PASSWORD_SALT`  | Yes (for accounts) |       16 chars | Pepper for password hashing. Never changes after first use.                    |
| `SESSION_SECRET` | Yes (for accounts) |       16 chars | HMAC key for signing session tokens. Can be rotated — that signs everyone out. |

Generate both securely (paste into browser console):

``` javascript
crypto.randomUUID() + crypto.randomUUID()
```

Each call gives you a roughly 72-character string. Use one for
`PASSWORD_SALT`, one for `SESSION_SECRET`. Never commit them to git.

If the server is missing either variable, all `/api/notes.js`-style
scripts return a clean `500 Server misconfigured: PASSWORD_SALT` (or
`SESSION_SECRET`) — you'll see this immediately on the first request.

------------------------------------------------------------------------

# Working with auth

Folio's backend runtime is a non-secure context. That means
`crypto.subtle` and `crypto.randomUUID` are not available. All crypto
must use:

- `crypto.getRandomValues()` — available in non-secure contexts, used
  for UUIDs.
- Pure-JS SHA-256 and HMAC — required because `crypto.subtle.digest` and
  `crypto.subtle.sign` throw in the sandbox.

Folio ships working implementations of both. When writing your own
`api/*.js` auth logic, copy them or import from a shared helper file.

## Preventing the sandbox crypto errors

| Wrong                                | Right                                     |
|--------------------------------------|-------------------------------------------|
| `crypto.randomUUID()`                | Use a `getRandomValues`-based UUID helper |
| `crypto.subtle.digest("SHA-256", …)` | Use a pure-JS SHA-256                     |
| `crypto.subtle.sign(…, "HMAC", …)`   | Use a pure-JS HMAC-SHA256                 |

Where to get them: see `api/notes.js` in this repo — `sha256Hex`,
`hmacSign`, `hashPassword`, and `uuid` are the reference
implementations.

------------------------------------------------------------------------

# Building an app on Folio

The repo ships with a full example — the notes app — that demonstrates
auth, private API routes, publishing, and image search. Use it as a
template.

## Project layout

A typical Folio app has:

``` text
your-project/
├── index.html            # Frontend (single page)
└── api/
    └── notes.js          # Backend routes
```

## The `api/*.js` file

Every `api/*.js` file is a single script. Actions are dispatched by
reading `REQ.body.action`:

``` javascript
// api/notes.js
const action = REQ.body && REQ.body.action;

if (action === "listNotes") {
  // ...
  return { success: true, notes: [] };
}

if (action === "createNote") {
  // ...
  return { success: true, note: { ... } };
}

return { __status: 400, __body: "Unknown action", error: "Unknown action" };
```

### Response shapes

| You return                                                   | Response                               |
|--------------------------------------------------------------|----------------------------------------|
| `{ success: true, data: … }`                                 | 200 `application/json` with the object |
| `"hello"` (string)                                           | 200 `text/plain` with the string       |
| `{ __status: 404, __body: "Not found", error: "Not found" }` | 404 with the error body                |
| `{ __contentType: "text/html", __body: "<h1>Hi</h1>" }`      | 200 `text/html` with the HTML          |

## Calling the DB from inside a script

Folio intercepts `fetch("/api/host?action=db/…")` in-process — the
request never leaves the sandbox. But `fetch` needs an absolute URL in
the sandbox, so always prefix with `ENV.FOLIO_BASE_URL`:

``` javascript
const BASE = ENV.FOLIO_BASE_URL; // e.g. "https://foliostudios.vercel.app"

const r = await fetch(`${BASE}/api/host?action=db/get&pid=${ENV.PROJECT_ID}`);
const { data } = await r.json();
```

Not:

``` javascript
// ❌ Fails with "Failed to parse URL" in the sandbox
const r = await fetch(`/api/host?action=db/get&pid=${ENV.PROJECT_ID}`);
```

## Reading the DB

`db/get` returns the whole project tree as `data`. Walk it yourself:

``` javascript
const r = await fetch(`${BASE}/api/host?action=db/get&pid=${ENV.PROJECT_ID}`);
const { data } = await r.json();

// data.notes = { note1: {...}, note2: {...} }
const notes = data.notes || {};
```

Do not use `db/list` for the primary read path unless you've verified
its response shape. In this codebase, `db/get` is the reliable
primitive. `db/list` returns an implementation-specific shape that
varies with Firebase's layout.

## Writing the DB

Single-path write:

``` javascript
await fetch(`${BASE}/api/host?action=db/set`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    pid: ENV.PROJECT_ID,
    key: `notes/${id}`,
    value: { title, content, at: Date.now() },
  }),
});
```

Atomic batch write (multiple paths in one call):

``` javascript
await fetch(`${BASE}/api/host?action=db/batch`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    pid: ENV.PROJECT_ID,
    updates: [
      { key: `notes/${id}`, value: note },
      { key: `userNotes/${userId}/${id}`, value: summary },
    ],
  }),
});
```

Delete a path (write `null`):

``` javascript
await fetch(`${BASE}/api/host?action=db/set`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    pid: ENV.PROJECT_ID,
    key: `notes/${id}`,
    value: null,
  }),
});
```

## Calling external APIs

If the host is in a trusted tier (image CDNs, well-known APIs, import
CDNs), just call it:

``` javascript
const r = await fetch("https://picsum.photos/v2/list?page=1&limit=12");
```

If the host is unfamiliar, add an `@allow` comment OR put the literal
URL somewhere in your script — the deploy pipeline auto-detects it:

``` javascript
// @allow api.weather.com
const r = await fetch("https://api.weather.com/v1/today");
```

------------------------------------------------------------------------

# API reference

The hosting API is available at:

``` text
https://foliostudios.vercel.app/api/host
```

## Hosting API endpoints

| Action                | Method | Authentication       | Purpose                                        |
|-----------------------|--------|----------------------|------------------------------------------------|
| `projects/list`       | GET    | Bearer               | List the user's projects                       |
| `projects/get`        | GET    | Bearer               | Retrieve a project                             |
| `projects/create`     | POST   | Bearer               | Create a project                               |
| `projects/update`     | POST   | Bearer               | Update name, description, or icon              |
| `projects/delete`     | POST   | Bearer               | Delete a project; owner only                   |
| `project/copy`        | POST   | Bearer               | Copy or fork a project                         |
| `project/export`      | GET    | Bearer               | Export a `.folio` or `.zip` file               |
| `project/sync-back`   | POST   | Bearer               | Synchronize files, versions, and database data |
| `deploy`              | POST   | Bearer               | Deploy project files                           |
| `redeploy`            | POST   | Bearer               | Redeploy a version                             |
| `status`              | GET    | Bearer               | Retrieve deployment status                     |
| `deployment/history`  | GET    | Bearer               | Retrieve deployment history                    |
| `deployment/offline`  | POST   | Bearer               | Take a deployment offline                      |
| `deployment/delete`   | POST   | Bearer               | Delete a deployment record                     |
| `visibility`          | POST   | Bearer               | Update project visibility                      |
| `apikey/generate`     | POST   | Bearer               | Generate a project API key                     |
| `invite/create`       | POST   | Bearer               | Invite a collaborator                          |
| `invite/list`         | GET    | Bearer               | List pending invitations                       |
| `invite/accept`       | POST   | Bearer               | Accept an invitation                           |
| `invite/cancel`       | POST   | Bearer               | Cancel an invitation                           |
| `collaborator/remove` | POST   | Bearer               | Remove a collaborator                          |
| `db/get`              | GET    | Optional project key | Read the JSON database                         |
| `db/set`              | POST   | Project API key      | Write to the JSON database                     |
| `db/schema`           | POST   | Bearer               | Update the database schema                     |
| `file/list`           | GET    | Optional             | List files through the code viewer             |
| `file/get`            | GET    | Optional             | Retrieve a file through the code viewer        |
| `serve`               | GET    | Optional             | Serve a deployed file                          |
| `api-routes`          | GET    | Bearer               | List registered API routes for a project       |
| `api-logs`            | GET    | Bearer               | Read recent user-route calls                   |
| `logs`                | GET    | Bearer               | Retrieve project activity logs                 |
| `hosts/add`           | POST   | Bearer (owner)       | Add an allowed host from the dashboard         |
| `share`               | GET    | Public               | Public share page                              |
| `profile`             | GET    | Public               | Public profile page                            |

Rate-limit information is returned through `X-RateLimit-*` response
headers where supported.

------------------------------------------------------------------------

# Private API runtime

Custom routes are declared by files in the project's `api/*.js` folder.
Each file becomes a route named after the file (without the `.js`
extension).

``` text
api/notes.js  →  POST /{username}/project/{slug}/api/notes
              →  POST /api/{pid}/notes
```

## Route discovery

``` bash
curl 'https://foliostudios.vercel.app/api/host?action=api-routes&pid=YOUR_PID' \
  -H 'Authorization: Bearer YOUR_SESSION_TOKEN'
```

Returns:

``` json
{
  "success": true,
  "system": ["health", "whoami", "files", "status", "version", "robots"],
  "user": ["notes", "chat"],
  "friendlyBaseUrl": "https://foliostudios.vercel.app/{username}/project/{slug}/api",
  "directBaseUrl": "https://foliostudios.vercel.app/api/YOUR_PID",
  "maxFiles": 10
}
```

## Reading the API logs

The `api-logs` endpoint returns the last 50 user-route calls, with
filter and pagination support:

``` bash
curl 'https://foliostudios.vercel.app/api/host?action=api-logs&pid=YOUR_PID&limit=20&offset=0' \
  -H 'Authorization: Bearer YOUR_SESSION_TOKEN'
```

Each log entry contains:

| Field                       | Meaning                                                              |
|-----------------------------|----------------------------------------------------------------------|
| `route`, `method`, `status` | What was called and what came back                                   |
| `durationMs`                | Total wall time                                                      |
| `via`                       | `anon`, `session`, or `api-key`                                      |
| `requestId`                 | Correlates with the `X-Request-Id` header and Vercel logs            |
| `stage`                     | Last `run.timing` stage reached — tells you where a failure happened |
| `bytesIn`, `bytesOut`       | Request and response sizes                                           |
| `fetchHosts`                | External hosts the script actually reached                           |
| `errorName`, `errorMessage` | If the script threw or returned an error                             |

Filters: `?status=error`, `?route=notes`, `?via=api-key`,
`?since=<unix-ms>`.

## AI endpoint

``` http
POST https://foliostudios.vercel.app/api/ai
```

| Field     | Type             | Description                                    |
|-----------|------------------|------------------------------------------------|
| `task`    | string           | One of the supported AI tasks                  |
| `pid`     | string, optional | Project ID; required for project-related tasks |
| `payload` | object           | Task-specific input                            |

------------------------------------------------------------------------

# Debugging runtime failures

When something in `api/*.js` fails, work through these checks in order.

## 1. Read the log entry

Open the API tab → Recent calls, or hit
`/api/host?action=api-logs&pid=YOUR_PID`. The entry tells you:

- `status` (200, 400, 500, 504)
- `stage` (where in the runtime execution stopped)
- `errorName`, `errorMessage` (the actual exception)

## 2. Interpret the stage

The runtime emits a `run.timing` event at every stage. Common stage →
cause mappings:

| Stage                     | Means                                                       |
|---------------------------|-------------------------------------------------------------|
| `query_parsed`            | Bad pid/route in the URL                                    |
| `slug_resolved`           | Username + slug didn't resolve to a project                 |
| `ctx_loaded`              | Project record missing, or route not in `apiRoutes`         |
| `route_file_loaded`       | `api/*.js` file not found in storage                        |
| `hosts_parsed`            | A literal URL in your script couldn't be validated          |
| `secrets_loaded`          | `ENV` build failed                                          |
| `html_built`              | Script too large to embed                                   |
| `browser_launch_started`  | Chromium failed to launch (cold-start, memory)              |
| `setcontent_started`      | Page setup timed out                                        |
| `waitforfunction_started` | Script never set `window.__RESULT__` (usually a 7s timeout) |
| `page_executed`           | Script ran but threw — check `errorName`                    |

## 3. Read the response body

If the script returns `{ __status: 400, __body: "…", error: "…" }`,
that's a clean rejection — the runtime worked. Look at `errorMessage` in
the log to see the reason.

## 4. Understand `null` responses

`null` responses mean the script returned `undefined`.

If you see `"null"` in the response body, the script fell through a
branch without returning anything. Wrap the whole script in a top-level
`try/catch` and return a fallback at the bottom:

``` javascript
try {
  // ... your actions ...
  return { __status: 400, error: "Unknown action" };
} catch (e) {
  return { __status: 500, error: "Script error: " + e.message };
}
```

## 5. Fix "Failed to parse URL" from `fetch`

In the sandbox, `fetch("/api/host")` has no base URL. Always use an
absolute URL built from `ENV.FOLIO_BASE_URL`.

## 6. Fix crypto errors

If `crypto.subtle` / `crypto.randomUUID` are not defined, remember that
the sandbox is not a secure context. Use pure-JS SHA-256/HMAC and a
`getRandomValues` UUID helper.

## 7. Fix `Buffer.byteLength(undefined)`

The runtime has an active fix for this — if you see it at `run.js` line
1232, you're on an old version of `run.js`. Update to the latest.

------------------------------------------------------------------------

# Project structure

The main application layout:

``` text
.
├── index.html               # Main editor
├── project.html             # Project dashboard
├── projects.html            # Project library
├── profile.html             # Public profile
├── register.html            # Sign up and sign in
├── settings.html            # Account settings
├── analytics.html           # Usage analytics
├── tools.html               # Web development utilities
├── offline.html             # Offline fallback
├── invite.html              # Invitation acceptance
│
├── app.css                  # Editor styles
├── project.css              # Project dashboard styles
│
├── js/
│   ├── ai.js                # AI panel and artifact renderers
│   └── create-project.js    # Shared project creation flow
│
├── manifest.json            # PWA manifest
├── sw.js                    # Service worker
├── install.js               # Installation prompt manager
├── update.js                # Update prompt manager
├── fcm-client.js            # FCM push subscription manager
├── notifications.js         # Notification panel and prompt
├── firebase-messaging-sw.js # FCM background handler
│
├── api/
│   ├── host.js              # Hosting, deployment, database, sharing, logs, hosts/add
│   ├── run.js               # Private API runtime (Chromium sandbox)
│   ├── auth.js              # Authentication and session endpoints
│   ├── ai.js                # AI task dispatcher
│   ├── flier.js             # Image generation and avatar upload
│   ├── analytics.js         # Usage analytics
│   ├── notify.js            # Notification dispatch
│   └── notes.js             # Example app: notes with auth, publishing, images
│
├── utils/
│   ├── firebase.js          # Firebase Admin initialization
│   ├── users.js             # Authentication, roles, rate limits, logging
│   ├── projectdb.js         # JSON database operations
│   ├── projectsecret.js     # Secret storage and encryption
│   └── log.js               # Structured logging
│
├── public/
│   ├── api-system-default.js  # Default _system.js template
│   ├── project-template.html  # Project page template
│   └── profile-template.html  # Public profile template
│
├── icons/                   # PWA icons
├── screenshots/             # Application screenshots
│
├── home.html                # Landing page
├── vercel.json              # Rewrite and header configuration
└── README.md                # Project documentation
```

------------------------------------------------------------------------

# Development

Folio uses a static frontend and a serverless backend on Vercel.

The frontend has no build step. It uses HTML, CSS, and JavaScript, with
CodeMirror loaded through CDN-based ES modules and import maps.

The AI client module is `js/ai.js`. It contains the panel, task
dispatcher, Markdown renderer, Mermaid/KaTeX loaders, artifact
renderers, pending staging, and inline context menu.

The private API runtime is `api/run.js`. It resolves project slugs,
launches Chromium via `@sparticuz/chromium-min`, executes `api/*.js`
scripts in an isolated page, and enforces the allowlist, timeouts, rate
limits, and response size caps.

## Requirements

- Git
- Node.js 20 or later and npm
- A Firebase project with the required backend credentials
- A Groq API key for AI features (optional)
- Vercel CLI for local serverless development

## 1. Clone the repository

``` bash
git clone https://github.com/YOUR_USERNAME/folio.git
cd folio
```

## 2. Install dependencies

``` bash
npm install
```

## 3. Configure environment variables

``` bash
cp .env.example .env
```

Fill in the required values:

``` dotenv
FIREBASE_PROJECT_ID=your_firebase_project_id
FIREBASE_CLIENT_EMAIL=your_service_account_email
FIREBASE_PRIVATE_KEY="your_private_key"
ADMIN_API_KEY=your_admin_api_key
BASE_URL=https://foliostudios.vercel.app
FLIER_INTERNAL_URL=your_internal_flier_url

# Auth — generate with crypto.randomUUID() + crypto.randomUUID()
PASSWORD_SALT=your_generated_salt
SESSION_SECRET=your_generated_secret

# AI (optional)
GROQ_API_KEY=your_groq_api_key
GROQ_MODEL=llama-3.3-70b-versatile
GROQ_MODEL_FAST=llama-3.1-8b-instant
```

**Security:** Never commit `.env`, Firebase service-account credentials,
administrator keys, Groq API keys, `PASSWORD_SALT`, or `SESSION_SECRET`
to a public repository. Configure production secrets through Vercel's
environment settings.

## 4. Run locally

``` bash
npx vercel dev
```

The frontend can be used for local-only projects without a functioning
backend. Features such as sign-in, deployment, cloud synchronization,
private API calls, and AI tasks require the backend to be configured.

## Testing offline behaviour

Service workers require HTTPS or a supported localhost environment.

Use Vercel's local development server or deploy a preview to test
installation, caching, offline fallback, and update behaviour.

### Updating the service worker cache

Edit `CACHE_VERSION` in `sw.js` whenever a deployment requires a new
application-shell cache.

``` javascript
const CACHE_VERSION = '2026-10-24-1';
```

For a later release:

``` javascript
const CACHE_VERSION = '2026-10-24-2';
```

Old caches are cleaned up during service-worker activation.

## Adding a language to the editor

1.  Add the language package URL to `CACHED_FILES` in `sw.js`, if
    required.
2.  Add the appropriate language extension to the loader in
    `index.html`. Search for `getLanguageExtension`.
3.  Update `detectLanguage` if the file extension is not already
    supported.
4.  Test highlighting, autocomplete, and offline behaviour.

## Adding an AI task

1.  Add the task to `TASK_META`, `GUEST_TASKS` if guest-accessible,
    `TASK_LIMITS`, and `TASK_BUILDERS` in `api/ai.js`.
2.  Add the prompt builder function.
3.  If the task returns an artifact, add a validator to
    `ARTIFACT_VALIDATORS`.
4.  Add the client-side artifact renderer in `js/ai.js`.
5.  Add the payload builder to `runCurrent` in `js/ai.js`.
6.  Test with authenticated and guest sessions.

## Adding a private API route

1.  Create a file in the project's `api/` folder — e.g. `api/hello.js`.
2.  Write the script. Anything returned becomes the response body.
3.  If the script calls unfamiliar hosts, add `// @allow host.name` or
    include a literal URL — the deploy pipeline auto-detects literal
    `https://host/...` URLs.
4.  Deploy the project.
5.  Call it from the frontend at `/{username}/project/{slug}/api/hello`
    or `/api/{pid}/hello`.
6.  Test both URL shapes.
7.  Inspect the API tab to confirm the route was registered.

## Adding a trusted host tier

Edit `api/run.js` and add to the appropriate set:

- `BUILTIN_ALLOWED_HOSTS` — well-known API hosts
- `TRUSTED_IMAGE_HOSTS` — image CDNs
- `ALLOWED_IMPORT_HOSTS` — CDN import hosts

Mirror the change in `api/host.js` (`TRUSTED_IMAGE_HOSTS`,
`KNOWN_SAFE_HOSTS`) so deploy-time validation skips the DNS probe for
those hosts.

## Adding auth to a new `api/*.js` app

1.  Copy the crypto helpers from `api/notes.js`: `sha256Hex`,
    `hmacSign`, `hashPassword`, `safeEqualHex`, `uuid`.
2.  Copy `createSessionToken`, `verifySessionToken`, `resolveSession`.
3.  Wire up the actions: `register`, `login`, `session`,
    `changePassword`, `deleteAccount`.
4.  Protect user-scoped actions with `resolveSession(token)` — return
    401 when it fails.
5.  Set `PASSWORD_SALT` and `SESSION_SECRET` in the Secrets tab before
    anyone registers.

------------------------------------------------------------------------

# Technology stack

| Layer             | Technology                                                                      |
|-------------------|---------------------------------------------------------------------------------|
| Frontend          | HTML, CSS, JavaScript                                                           |
| Code editor       | CodeMirror 6                                                                    |
| Editor modules    | deno.land/x/codemirror_esm                                                      |
| Local storage     | IndexedDB                                                                       |
| Server database   | Firebase Realtime Database                                                      |
| Authentication    | Email + password, pure-JS SHA-256 + HMAC, session tokens                        |
| Password hashing  | SHA-256(`PASSWORD_SALT | password | PASSWORD_SALT`) — pepper stored in env only |
| Session signing   | HMAC-SHA256(payload, `SESSION_SECRET`)                                          |
| Hosting           | Vercel serverless functions                                                     |
| API runtime       | `@sparticuz/chromium-min` + `puppeteer-core`                                    |
| AI provider       | Groq                                                                            |
| AI models         | `llama-3.3-70b-versatile`, `llama-3.1-8b-instant`                               |
| Diagram rendering | Mermaid                                                                         |
| Math rendering    | KaTeX                                                                           |
| Image generation  | Custom Flier integration                                                        |
| Code formatting   | Prettier through esm.sh                                                         |
| PWA               | Custom service worker, installation, and update managers                        |
| Fonts             | Inter and JetBrains Mono                                                        |

------------------------------------------------------------------------

# Roadmap

These are planned improvements, not claims about currently available
features.

- [ ] Git integration: commits, pushes, and branches
- [ ] Built-in terminal and shell commands
- [ ] Bundler support: Vite and esbuild
- [ ] Multi-file search
- [ ] Reusable snippets library
- [ ] Custom domains
- [ ] Server-side rendering for public projects
- [ ] Team workspaces beyond individual project collaborators
- [ ] API: scheduled and cron-triggered routes
- [ ] API: streaming responses for long-running scripts
- [ ] AI: fine-grained task permissions per collaborator
- [ ] AI: shared team-level rate limits

------------------------------------------------------------------------

# Contributing

Contributions, bug reports, feature requests, and improvements are
welcome.

For substantial changes, open an issue first to discuss the proposed
approach.

## Development principles

- **Mobile-first.** Design for touchscreens before adapting the
  interface for desktop.
- **Offline-first.** Network-dependent features should fail gracefully
  and preserve locally available work.
- **Lightweight.** Keep the frontend static and avoid introducing a
  build step without a clear need.
- **Accessible.** Interactive controls should support keyboard
  navigation and accessible labels.
- **Privacy-conscious.** Avoid unnecessary tracking and analytics.
  Review third-party integrations and disclose any data collection that
  is introduced.
- **AI proposes, user confirms.** Every AI write goes through explicit
  user acceptance. Nothing is auto-applied.

## Reporting issues

When reporting a bug, include:

- What you were trying to do.
- What you expected to happen.
- What actually happened.
- Your device, browser, and operating system.
- Steps to reproduce the issue.
- Relevant error messages or screenshots.

For AI-related issues, include the task name, whether you were signed
in, and the exact AI response if any. For private API issues, include
the route name, the `api/*.js` content, and the response you received.
Redact anything you do not want to share.

------------------------------------------------------------------------

# License

Folio is intended to be distributed under the MIT License.

See the `LICENSE` file for the full license text.

If the repository does not yet contain that file, add the correct
license before describing the project as officially MIT-licensed.

------------------------------------------------------------------------

<div align="center">

<img src="https://foliostudios.vercel.app/icons/icon-192.png" alt="Folio" width="56" height="56">

**Build from anywhere.**

Made for developers who carry their workspace in their pocket.

Write your code. Test your ideas. Ship your projects.

Open Folio · Read the docs · Report a bug

<sub>Folio — Code in your pocket.</sub>

</div>
