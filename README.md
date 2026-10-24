
<div align="center">

<img src="https://foliostudios.vercel.app/icons/icon-192.png" alt="Folio Logo" width="100" height="100">

# Folio

### Code in your pocket.

**A mobile-first, offline-first code editor built for the way you code.**

Write, preview, manage, and deploy websites directly from your phone.
No desktop setup. No build step. No account required to get started.

[![Open Folio](https://img.shields.io/badge/OPEN-FOLIO-F59E0B?style=for-the-badge&logo=googlechrome&logoColor=white)](https://foliostudios.vercel.app)
[![Documentation](https://img.shields.io/badge/READ-DOCS-3B82F6?style=for-the-badge)](https://foliostudios.vercel.app/#docs)
[![Progressive Web App](https://img.shields.io/badge/PWA-INSTALLABLE-10B981?style=for-the-badge)](https://foliostudios.vercel.app)

[Website](https://foliostudios.vercel.app) · [Documentation](https://foliostudios.vercel.app/#docs) · [Report a bug](https://github.com)

</div>

---

## Overview

Folio is a browser-based development environment that makes building websites practical on mobile devices.

It combines a code editor, file manager, live preview, version snapshots, project hosting, and a built-in JSON database in one lightweight workspace.

Projects are stored locally first, so you can keep working when your internet connection disappears. When you're ready to publish, deploy your project to a live URL and share it with anyone.

**Start locally. Work offline. Publish when you're ready.**

### At a glance

| Capability | What it means |
|---|---|
| Mobile-first | Designed for touchscreens and small displays |
| Offline-first | Local projects remain available without internet |
| Live preview | See your code run without a build step |
| One-tap deployment | Publish projects to a live URL |
| Built-in JSON database | Add simple dynamic data to your projects |
| AI assistant | Explain, fix, and draft code through staged proposals |
| Collaboration | Invite people with different project permissions |
| Version history | Save snapshots and restore earlier work |
| No-account entry | Start coding before signing in |

<div align="center">

### Your development workspace, wherever you are.

<img src="https://foliostudios.vercel.app/screenshots/screenshot1.png" alt="Folio code editor" width="260">

</div>

---

## Screenshots

Explore the main parts of the Folio experience.

<div align="center">

### Code editor

<img src="https://foliostudios.vercel.app/screenshots/screenshot1.png" alt="Code editor with syntax highlighting" width="300">

### Project library

<img src="https://foliostudios.vercel.app/screenshots/screenshot2.png" alt="Folio project library" width="300">

### Live preview

<img src="https://foliostudios.vercel.app/screenshots/screenshot3.png" alt="Website rendered in Folio preview" width="300">

### Deployments

<img src="https://foliostudios.vercel.app/screenshots/screenshot4.png" alt="Project deployments dashboard" width="300">

### JSON database

<img src="https://foliostudios.vercel.app/screenshots/screenshot5.png" alt="Folio JSON database interface" width="300">

### AI Lens

<img src="https://foliostudios.vercel.app/screenshots/screenshot6.png" alt="Folio AI Lens panel" width="300">

</div>

---

## Features

### 01. A real code editor

Write and manage code with a development environment designed for mobile.

- Syntax highlighting for HTML, CSS, JavaScript, TypeScript, JSX/TSX, JSON, Markdown, Python, and more.
- Autocomplete and bracket matching.
- Multiple cursors.
- Find text in the current file using `Ctrl/Cmd + F`.
- Format HTML, CSS, JavaScript, JSON, and Markdown with Prettier.
- Save version snapshots with commit messages.
- Compare versions and restore earlier snapshots.

### 02. Live preview

Test your work as you build it.

- Full-screen preview, mini panel, or a separate browser tab.
- Multi-file HTML projects with CSS and JavaScript.
- Console output returned to the editor.
- No mandatory compilation or bundling step for ordinary static projects.

### 03. One-tap deployment

Turn a project into a shareable website.

- Publish projects to a live URL.
- Keep deployment versions and redeploy previous versions.
- Take a deployment offline without deleting your local files.
- Serve project assets and relative URLs through Folio's hosting endpoint.

### 04. Built-in JSON database

Give projects a simple hosted data store without building a database backend from scratch.

- Read project data through an HTTP API.
- Authenticate writes with a project API key.
- Update individual paths, merge top-level data, or replace the database.
- Store configuration, guestbook entries, small collections, feature flags, and other lightweight application data.

**Default limits:** 15 MB per project database and 100 writes per hour per project.

These limits and access rules are enforced by the backend.

### 05. AI assistant

Folio includes an AI helper that lives in the editor and dashboard — the **Lens** panel.

- **22 tasks** across understanding, fixing, building, documenting, and diagnosing code.
- **Explain, debug, fix, optimize, refactor, document, audit, translate** — with patch previews you accept or reject.
- **Diagrams** as Mermaid, mind maps, and flow tables — rendered inline in your notes.
- **Commit and deploy drafts** — the AI drafts text; you approve before anything is applied.
- **Offline-safe rendering.** Markdown, diagrams, math, and diffs render locally once the app is cached.
- **Nothing is auto-applied.** AI drafts live in a staged queue until you accept them.

AI tasks require a connection. Rendering AI output works offline once the necessary assets are cached.

**The AI never writes to your project automatically.** It drafts text and proposed changes. You decide what to apply.

### 06. Sharing and collaboration

Control how your projects are shared.

- Configure independent visibility settings for your profile, live site, code viewer, language information, and JSON database API.
- Invite collaborators as viewers, commenters, or editors.
- Maintain a public profile with a list of projects.
- Share project pages using URLs such as:

  `https://foliostudios.vercel.app/<username>/<slug>`

### 07. Offline-first PWA

Folio is designed to remain useful when connectivity is unreliable.

- Store projects in IndexedDB before relying on cloud synchronization.
- Install the app from a supported browser.
- Cache the application shell using a cache-first strategy.
- Use stale-while-revalidate caching for eligible assets.
- Prompt users when an updated application version becomes available.
- Queue supported synchronization operations for later processing.

### 08. Export and portability

Your work should not be trapped in one editor.

| Format | Contents |
|---|---|
| `.folio` | Full project backup, including files, versions, JSON database, and schema |
| `.zip` | Current project files |
| `.json` | JSON database data |

Import a `.folio` backup to restore a project.

---

## Getting started

You can start coding without installing anything.

1. Open [Folio](https://foliostudios.vercel.app) in your browser.
2. Select **New project**.
3. Enter a project name and choose an icon.
4. Open the editor and start writing code.
5. Use the preview control to run your project.
6. Sign in when you need cloud synchronization, deployment, collaboration, or account-dependent AI features.

New projects automatically receive starter files:

```text
index.html
style.css
app.js
```

### Install Folio on your phone

1. Open Folio in a supported browser.
2. Open the browser menu.
3. Select **Install app** or **Add to Home screen**, depending on your browser.
4. Launch Folio from your home screen.

Installation availability depends on the browser and platform.

---

## How Folio works

### The three core panels

| Panel | Purpose |
|---|---|
| Editor | Write code, search, format, and manage versions |
| Files | Create, rename, and organize project files |
| Preview | Run the project and inspect its output |

### Storage architecture

Folio uses browser storage for local work and server storage for supported cloud features.

| Store | Purpose |
|---|---|
| `projects` | Project metadata, including IDs, names, slugs, icons, timestamps, and roles |
| `files` | File contents, keyed by project ID and path |
| `versions` | Version snapshots and commit messages |
| `projectMeta` | Project-specific notes and notepad data |
| `syncQueue` | Pending synchronization operations |

The browser uses IndexedDB for local project data. Server-side project data is handled by the backend and Firebase Realtime Database.

Offline availability does not mean every cloud feature works offline. Authentication, remote deployment, cloud synchronization, hosted database operations, and AI tasks require connectivity.

### How deployment works

Folio stores deployed project files and serves them through a hosting endpoint.

Example:

```text
https://foliostudios.vercel.app/api/host?action=serve&pid=YOUR_PID&path=index.html
```

The serving handler rewrites supported relative asset references so files such as `style.css` and `app.js` can be loaded through the hosting endpoint.

This allows ordinary multi-file static projects to work without a separate build configuration.

---

## The JSON database

Every project can use a hosted JSON database for lightweight application data.

Configure access through **Sharing → JSON database API**.

Public reads depend on the project's visibility settings. Writes require the project's API key.

### 1. Read data

```javascript
const response = await fetch(
  'https://foliostudios.vercel.app/api/host' +
  '?action=db/get&pid=YOUR_PID'
);

if (!response.ok) {
  throw new Error(`Database request failed: ${response.status}`);
}

const result = await response.json();

console.log(result.data);
```

Replace `YOUR_PID` with your actual project ID.

### 2. Write to a path

Use a path write to update a specific value while preserving unrelated sibling data.

```javascript
const response = await fetch(
  'https://foliostudios.vercel.app/api/host' +
  '?action=db/set&pid=YOUR_PID',
  {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-project-key': 'YOUR_PROJECT_API_KEY'
    },
    body: JSON.stringify({
      pid: 'YOUR_PID',
      key: 'posts/p_abc/heart',
      value: 42
    })
  }
);

if (!response.ok) {
  throw new Error(`Database write failed: ${response.status}`);
}
```

Use path writes when updating one item in a larger collection.

### 3. Merge data

A merge write replaces each supplied top-level subtree while preserving unrelated top-level keys.

```javascript
const response = await fetch(
  'https://foliostudios.vercel.app/api/host' +
  '?action=db/set&pid=YOUR_PID',
  {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-project-key': 'YOUR_PROJECT_API_KEY'
    },
    body: JSON.stringify({
      pid: 'YOUR_PID',
      data: {
        config: {
          theme: 'dark'
        }
      },
      mode: 'merge'
    })
  }
);
```

**Important:** This is not a deep merge. Sending `config` replaces the entire existing `config` subtree. It does not update only `config.theme`.

### 4. Replace the database

A replacement write replaces the entire database contents.

```javascript
const response = await fetch(
  'https://foliostudios.vercel.app/api/host' +
  '?action=db/set&pid=YOUR_PID',
  {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-project-key': 'YOUR_PROJECT_API_KEY'
    },
    body: JSON.stringify({
      pid: 'YOUR_PID',
      data: {
        config: {},
        posts: {},
        members: {}
      }
    })
  }
);
```

Use replacement writes carefully because existing data may be lost.

### Database limits

| Limit | Value |
|---|---|
| Maximum database size | 15 MB per project |
| Write rate | 100 writes per hour per project |
| Transaction support | Writes are not transactional |

See the [Folio documentation](https://foliostudios.vercel.app/#docs) for additional details.

---

## The AI assistant (Lens)

The Lens panel lives in the sidebar of both the editor and the project dashboard.

### How it works

1. Pick a task from the dropdown.
2. Choose a scope: file or selection.
3. Click **Run**, or right-click a selection in the editor to run a task directly.
4. The AI returns Markdown text and typed artifacts, such as findings, diffs, files, diagrams, and drafts.
5. Write-apply tasks stage their proposals in the pending queue.
6. Review each patch and accept or reject it.
7. Before applying a patch, Folio verifies that the original text still matches the expected content.

### What AI can do

| Category | Tasks |
|---|---|
| Understand | `explain`, `diagram`, `simulate`, `designExplain` |
| Fix and improve | `debug`, `codefix`, `optimize`, `suggest`, `audit` |
| Build and transform | `scaffold`, `translate`, `docstrings` |
| Content and metadata | `metatags`, `brainstorm`, `commitMsg`, `docs`, `logExplain` |
| Diagnose | `findFn`, `struggle` |
| Hosting drafts | `readProject`, `commitDraft`, `deployDraft` |

### Guest vs. signed-in access

| Capability | Guest | Signed in |
|---|---|---|
| Available tasks | 5 selected tasks | All 22 tasks |
| Rate limits | Per-IP limits | Per-user limits |
| AI changes | Proposals only | Proposals requiring approval |

The exact task availability and limits are determined by the backend configuration.

### The safety rule

**AI proposals require explicit user approval before being applied.**

- `commitDraft` returns text, a message, and a changed-file list; it does not return file contents for automatic writing.
- `deployDraft` returns text, a summary, and a changed-file list; it does not deploy automatically.
- Applying a patch writes through the client's IndexedDB, followed by the existing synchronization flow.
- Committing pre-fills the message in the existing commit dialog.
- Deploying pre-fills the summary in the existing deployment confirmation.

Everything that touches project files follows the accepted-patch workflow or an existing commit/deploy flow requiring user approval.

### Offline behaviour

AI tasks require a connection. Rendering does not, once the necessary assets are cached.

| Works offline | Requires a connection |
|---|---|
| Markdown, tables, and task lists | Running an AI task |
| Cached Mermaid diagram rendering | Fetching new diagram assets |
| Cached KaTeX math rendering | Fetching new math assets |
| Diffs and patch previews | Requesting new AI proposals |
| Viewing pending proposals | Cloud synchronization when applying changes |

First-time rendering may require internet access to download the relevant assets.

---

## API reference

The hosting API is available at:

```text
https://foliostudios.vercel.app/api/host
```

### Hosting API endpoints

| Action | Method | Authentication | Purpose |
|---|---|---|---|
| `projects/list` | GET | Bearer | List the user's projects |
| `projects/get` | GET | Bearer | Retrieve a project |
| `projects/create` | POST | Bearer | Create a project |
| `projects/update` | POST | Bearer | Update name, description, or icon |
| `projects/delete` | POST | Bearer | Delete a project; owner only |
| `project/copy` | POST | Bearer | Copy or fork a project |
| `project/export` | GET | Bearer | Export a `.folio` or `.zip` file |
| `project/sync-back` | POST | Bearer | Synchronize files, versions, and database data |
| `deploy` | POST | Bearer | Deploy project files |
| `redeploy` | POST | Bearer | Redeploy a version |
| `status` | GET | Bearer | Retrieve deployment status |
| `deployment/history` | GET | Bearer | Retrieve deployment history |
| `deployment/offline` | POST | Bearer | Take a deployment offline |
| `deployment/delete` | POST | Bearer | Delete a deployment record |
| `visibility` | POST | Bearer | Update project visibility |
| `apikey/generate` | POST | Bearer | Generate a project API key |
| `invite/create` | POST | Bearer | Invite a collaborator |
| `invite/list` | GET | Bearer | List pending invitations |
| `invite/accept` | POST | Bearer | Accept an invitation |
| `invite/cancel` | POST | Bearer | Cancel an invitation |
| `collaborator/remove` | POST | Bearer | Remove a collaborator |
| `db/get` | GET | Optional project key | Read the JSON database |
| `db/set` | POST | Project API key | Write to the JSON database |
| `db/schema` | POST | Bearer | Update the database schema |
| `file/list` | GET | Optional | List files through the code viewer |
| `file/get` | GET | Optional | Retrieve a file through the code viewer |
| `serve` | GET | Optional | Serve a deployed file |
| `logs` | GET | Bearer | Retrieve project activity logs |
| `share` | GET | Public | Public share page |
| `profile` | GET | Public | Public profile page |

**Authentication note:** `Bearer` indicates an authenticated session token. Optional or public access does not imply unrestricted access; individual visibility settings and server-side authorization still apply.

Rate-limit information is returned through `X-RateLimit-*` response headers where supported.

### AI endpoint

```http
POST https://foliostudios.vercel.app/api/ai
```

| Field | Type | Description |
|---|---|---|
| `task` | string | One of the supported AI tasks |
| `pid` | string, optional | Project ID; required for project-related tasks |
| `payload` | object | Task-specific input |

Example response:

```json
{
  "success": true,
  "task": "debug",
  "text": "Found 2 issues...",
  "artifacts": [],
  "usage": {
    "promptTokens": 1840,
    "completionTokens": 620,
    "model": "llama-3.3-70b-versatile"
  },
  "guest": false,
  "cached": false,
  "rateLimit": {
    "limit": 30,
    "remaining": 27,
    "reset": "2026-10-25T04:00:00.000Z"
  }
}
```

The example illustrates the response structure. Actual fields and values depend on the implementation and request.

The AI endpoint returns text and typed artifacts. It does not directly write to project files.

---

## Project structure

The following is the main application layout.

```text
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
│   ├── host.js              # Hosting, deployment, database, sharing, logs
│   ├── auth.js              # Authentication and session endpoints
│   ├── ai.js                # AI task dispatcher
│   ├── flier.js             # Image generation and avatar upload
│   ├── analytics.js         # Usage analytics
│   └── notify.js            # Notification dispatch
│
├── utils/
│   ├── firebase.js          # Firebase Admin initialization
│   ├── users.js             # Authentication, roles, rate limits, logging
│   └── log.js               # Structured logging
│
├── icons/                   # PWA icons
├── screenshots/             # Application screenshots
│
├── home.html                # Landing page
└── README.md                # Project documentation
```

---

## Development

Folio uses a static frontend and a serverless backend on Vercel.

The frontend has no build step. It uses HTML, CSS, and JavaScript, with CodeMirror loaded through CDN-based ES modules and import maps.

The AI client module is `js/ai.js`. It contains the panel, task dispatcher, Markdown renderer, Mermaid/KaTeX loaders, artifact renderers, pending staging, and inline context menu. It is imported by `index.html` and `project.html`.

### Requirements

- Git
- Node.js and npm
- A Firebase project with the required backend credentials
- A Groq API key for AI features (optional)
- Vercel CLI for local serverless development

### 1. Clone the repository

```bash
git clone https://github.com/YOUR_USERNAME/folio.git
cd folio
```

Replace `YOUR_USERNAME/folio` with the actual repository URL.

### 2. Install dependencies

```bash
npm install
```

### 3. Configure environment variables

Create a `.env` file from the project's environment template, if one exists.

```bash
cp .env.example .env
```

Configure the required values:

```dotenv
FIREBASE_PROJECT_ID=your_firebase_project_id
FIREBASE_CLIENT_EMAIL=your_service_account_email
FIREBASE_PRIVATE_KEY="your_private_key"
ADMIN_API_KEY=your_admin_api_key
BASE_URL=https://foliostudios.vercel.app
FLIER_INTERNAL_URL=your_internal_flier_url

# AI (optional)
GROQ_API_KEY=your_groq_api_key
GROQ_MODEL=llama-3.3-70b-versatile
GROQ_MODEL_FAST=llama-3.1-8b-instant
```

Use the actual environment variable names expected by the backend.

**Security:** Never commit `.env`, Firebase service-account credentials, administrator keys, Groq API keys, or other private keys to a public repository. Configure production secrets through Vercel's environment settings.

### 4. Run locally

```bash
npx vercel dev
```

The frontend can be used for local-only projects without a functioning backend. Features such as sign-in, deployment, cloud synchronization, and AI tasks require the backend to be configured.

### Testing offline behaviour

Service workers require HTTPS or a supported localhost environment.

Use Vercel's local development server or deploy a preview to test installation, caching, offline fallback, and update behaviour.

### Updating the service worker cache

Edit `CACHE_VERSION` in `sw.js` whenever a deployment requires a new application-shell cache.

```javascript
const CACHE_VERSION = '2026-10-24-1';
```

For a later release, increment the version:

```javascript
const CACHE_VERSION = '2026-10-24-2';
```

Old caches are cleaned up during service-worker activation according to the cleanup logic. The update manager prompts users to apply available updates.

### Adding a language to the editor

1. Add the language package URL to `CACHED_FILES` in `sw.js`, if required.
2. Add the appropriate language extension to the loader in `index.html`. Search for `getLanguageExtension`.
3. Update `detectLanguage` if the file extension is not already supported.
4. Test highlighting, autocomplete, and offline behaviour.

### Adding an AI task

1. Add the task to `TASK_META`, `GUEST_TASKS` if guest-accessible, `TASK_LIMITS`, and `TASK_BUILDERS` in `api/ai.js`.
2. Add the prompt builder function.
3. If the task returns an artifact, add a validator to `ARTIFACT_VALIDATORS`.
4. Add the client-side artifact renderer in `js/ai.js`.
5. Add the payload builder to `runCurrent` in `js/ai.js`.
6. Test with authenticated and guest sessions.

---

## Technology stack

| Layer | Technology |
|---|---|
| Frontend | HTML, CSS, JavaScript |
| Code editor | CodeMirror 6 |
| Editor modules | `deno.land/x/codemirror_esm` |
| Local storage | IndexedDB |
| Server database | Firebase Realtime Database |
| Authentication | Session tokens through `api/auth.js` |
| Hosting | Vercel serverless functions |
| AI provider | Groq |
| AI models | `llama-3.3-70b-versatile`, `llama-3.1-8b-instant` |
| Diagram rendering | Mermaid |
| Math rendering | KaTeX |
| Image generation | Custom Flier integration |
| Code formatting | Prettier through `esm.sh` |
| PWA | Custom service worker, installation, and update managers |
| Fonts | Inter and JetBrains Mono |

---

## Roadmap

These are planned improvements, not claims about currently available features.

- [ ] Git integration: commits, pushes, and branches
- [ ] Built-in terminal and shell commands
- [ ] Bundler support: Vite and esbuild
- [ ] Multi-file search
- [ ] Reusable snippets library
- [ ] Custom domains
- [ ] Server-side rendering for public projects
- [ ] Team workspaces beyond individual project collaborators
- [ ] AI: fine-grained task permissions per collaborator
- [ ] AI: shared team-level rate limits

---

## Contributing

Contributions, bug reports, feature requests, and improvements are welcome.

For substantial changes, open an issue first to discuss the proposed approach.

### Development principles

**Mobile-first**

Design for touchscreens before adapting the interface for desktop.

**Offline-first**

Network-dependent features should fail gracefully and preserve locally available work.

**Lightweight**

Keep the frontend static and avoid introducing a build step without a clear need.

**Accessible**

Interactive controls should support keyboard navigation and accessible labels.

**Privacy-conscious**

Avoid unnecessary tracking and analytics. Review third-party integrations and disclose any data collection that is introduced.

**AI proposes, user confirms**

Every AI write goes through explicit user acceptance. Nothing is auto-applied.

### Reporting issues

When reporting a bug, include:

- What you were trying to do.
- What you expected to happen.
- What actually happened.
- Your device, browser, and operating system.
- Steps to reproduce the issue.
- Relevant error messages or screenshots.

For AI-related issues, include the task name, whether you were signed in, and the exact AI response if any. Redact anything you do not want to share.

---

## License

Folio is intended to be distributed under the MIT License.

See the [`LICENSE`](LICENSE) file for the full license text.

If the repository does not yet contain that file, add the correct license before describing the project as officially MIT-licensed.

---

<div align="center">

<img src="https://foliostudios.vercel.app/icons/icon-192.png" alt="Folio" width="56" height="56">

## Build from anywhere.

Made for developers who carry their workspace in their pocket.

**Write your code. Test your ideas. Ship your projects.**

[Open Folio](https://foliostudios.vercel.app) · [Read the docs](https://foliostudios.vercel.app/#docs) · [Report a bug](https://github.com)

<sub>Folio — Code in your pocket.</sub>

</div>
