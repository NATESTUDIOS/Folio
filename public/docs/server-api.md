Building api/*.js Routes for Your Folio Project

A complete developer guide to Folio's private API runtime.

---

Table of contents

1. What this is
2. Your first route
3. The three globals: REQ, ENV, FILES
4. URLs and routing
5. Returning a response
6. Reaching external APIs with @allow
7. Importing from CDNs
8. Secrets and configuration
9. The built-in JSON database
10. Auth: who can call your route
11. The runtime environment
12. Limits and quotas
13. Errors and status codes
14. The _system.js file and system routes
15. Testing your routes
16. Common patterns
17. Debugging checklist
18. What not to do

---

What this is

Every Folio project has a private backend. You write JavaScript files in the api/ folder. Deploy the project. Call your scripts over HTTP from your frontend.

There's no server to configure, no Docker, no framework, no build step. You write a .js file, deploy, and it responds to HTTP requests.

Each script runs inside an isolated Chromium sandbox on Vercel's serverless infrastructure. That means you get the full browser environment: fetch, crypto, TextEncoder, Intl, Date, Math, JSON, URL, Blob, atob/btoa, and every other standard API you'd have in a real browser tab. If it works in Chrome, it works in your script.

---

Your first route

Create a file called api/hello.js:

```javascript
return { message: "Hello from the server!" };
```

That's the whole file. No function wrapper, no module.exports, no res.send. Whatever your script returns becomes the response body.

Deploy the project. Then call the route from your frontend or via curl:

```bash
curl -X POST 'https://foliostudios.vercel.app/{username}/project/{slug}/api/hello'
```

Response:

```json
{"message": "Hello from the server!"}
```

You've just written a working API endpoint.

---

The three globals: REQ, ENV, FILES

Every script has access to three variables. They're injected by the runtime before your code runs.

REQ — the incoming request

Field Type Description
REQ.method string HTTP method — "GET", "POST", etc.
REQ.body object Parsed JSON body from the request. {} if no body.
REQ.headers object Request headers — "content-type", "user-agent"
REQ.query object Query string parameters as key/value pairs
REQ.route string The route name — "hello" for api/hello.js
REQ.pid string Your project's ID
REQ.username string \| null The project owner's username
REQ.projectSlug string \| null The project's URL slug
REQ.projectName string \| null The project's display name
REQ.deployedAt number \| null Timestamp of the current deployment
REQ.deploymentId string \| null The current deployment's ID
REQ.versionId string \| null The current version's ID
REQ.deploymentUrl string \| null The live URL for this deployment
REQ.region string Vercel region — e.g. "iad1"
REQ.publicFileCount number Count of public files in the project
REQ.publicFileList array Full public file list

Important: REQ.body and REQ.query are frozen. Read them, don't mutate them.

ENV — your secrets

A frozen object containing every secret you've stored in the Secrets tab of the project dashboard.

```javascript
const apiKey = ENV.OPENAI_API_KEY;
```

Plus a set of reserved variables that Folio injects automatically:

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

ENV is per-invocation. You can't cache it across calls.

FILES — the public file list

A frozen object describing your project's public files:

```javascript
{
  files: [
    { path: "index.html", bytes: 4821, type: "text/html; charset=utf-8" },
    { path: "app.js", bytes: 26469, type: "application/javascript; charset=utf-8" },
    { path: "app.css", bytes: 32853, type: "text/css; charset=utf-8" }
  ],
  count: 3,
  totalBytes: 64143
}
```

Use FILES to serve manifest data, sitemap routes, or dynamic file listings.

---

URLs and routing

Every api/*.js file becomes a route. The filename (without .js) is the route name.

File Route
api/hello.js hello
api/chat.js chat
api/users/create.js Invalid — no subfolders allowed
api/notes-v2.js notes-v2

Two URL shapes per route:

Friendly URL (preferred)

```text
POST /{username}/project/{slug}/api/{route}
```

Example:

```text
POST https://foliostudios.vercel.app/fortune/project/dynamic-notes/api/hello
```

Reads naturally. Shareable. This is what you document.

Direct URL (fast-path)

```text
POST /api/{pid}/{route}
```

Example:

```text
POST https://foliostudios.vercel.app/api/p_1793827518396_b919f6/hello
```

Skips the slug→pid lookup. Faster on the first call, identical behavior otherwise.

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

---

Returning a response

Whatever your script returns becomes the response body. There are four patterns.

1. JSON (the default)

```javascript
return { ok: true, message: "Hello" };
```

Response: {"ok":true,"message":"Hello"} with Content-Type: application/json.

2. Plain text

```javascript
return "Hello, world!";
```

Response: Hello, world! with Content-Type: text/plain; charset=utf-8.

3. Custom status code and content type

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
__body The response body. Can be a string or object.

If your return object contains any of these keys, the runtime treats it as a special response envelope. Otherwise, the entire return value becomes the JSON body.

4. Errors

There's no built-in error helper. Just return an object:

```javascript
if (!REQ.body.name) {
  return { __status: 422, ok: false, error: "name is required" };
}
```

Or throw an exception:

```javascript
throw new Error("Something went wrong");
```

A thrown error returns:

```json
{
  "__status": 500,
  "__contentType": "application/json",
  "__body": "{\"success\":false,\"error\":\"Function threw an error\",\"route\":\"hello\"}"
}
```

Better pattern: always handle errors explicitly.

```javascript
try {
  // ... risky work
  return { ok: true, data: result };
} catch (err) {
  return { __status: 500, ok: false, error: err.message };
}
```

---

Reaching external APIs with @allow

By default, your script can only reach six built-in hosts:

· api.openai.com
· api.groq.com
· api.anthropic.com
· api.stripe.com
· api.supabase.co
· api.resend.com

To reach anything else, declare it at the top of your file with a @allow comment:

```javascript
// @allow api.weather.com
// @allow api.example.com

const weather = await fetch("https://api.weather.com/v1/today");
return await weather.json();
```

Rules

· One host per line. No wildcards, no paths, no ports.
· HTTPS only.
· Hostname only. api.example.com, not https://api.example.com/.
· No IP addresses. 10.0.0.5 will be rejected.
· No Folio infrastructure. *.vercel.app is blocked.
· Must respond to HTTPS. If the host doesn't, the deploy is rejected.
· Max 20 @allow lines per file.
· Max 50 unique hosts per project.

If you call an undeclared host, the request is blocked with a 403 — the fetch fails before it leaves the sandbox.

Validation timing

@allow hosts are validated at deploy time, not at runtime. When you deploy:

1. The runtime extracts all @allow hosts across all api/*.js files
2. Each host is DNS-resolved (rejects private IPs, localhost, reserved ranges)
3. Each host is tested for HTTPS reachability
4. All hosts are stored in projects/{pid}/allowedHosts for runtime reference

If validation fails, the entire deploy is rejected with a list of violations:

```json
{
  "success": false,
  "error": "Host validation failed",
  "violations": [
    { "host": "internal.example.com", "reason": "Resolves to private/reserved IP (10.0.0.5)" }
  ]
}
```

---

Importing from CDNs

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

Note: these imports happen at module load time. They're blocked from any other host.