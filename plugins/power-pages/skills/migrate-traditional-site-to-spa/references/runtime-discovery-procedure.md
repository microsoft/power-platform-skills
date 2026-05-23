# Runtime Discovery Procedure

Reference for `migrate-traditional-site-to-spa-analyze` Phase 4. Describes how the main agent crawls one session (anonymous or authenticated for a specific web role) with Playwright. The analyze SKILL drives the multi-session loop directly using `AskUserQuestion` between sessions; this reference holds the per-session crawl details so the orchestration in the SKILL stays readable.

Runtime discovery was previously delegated to a `migration-runtime-discoverer` subagent. That delegation was reverted because subagents cannot use `AskUserQuestion`, which blocks every authenticated-pass flow. The main agent now does the work itself.

## Contents

- [Session Model](#session-model)
- [Step 1: Load the home page and detect auth state](#step-1-load-the-home-page-and-detect-auth-state)
- [Step 2: Per-page crawl loop](#step-2-per-page-crawl-loop)
- [Step 3: Form discovery and SPA contract](#step-3-form-discovery-and-spa-contract)
- [Step 4: API surface aggregation](#step-4-api-surface-aggregation)
- [Step 5: Compare runtime against static (best-effort)](#step-5-compare-runtime-against-static-best-effort)
- [Artifact shapes](#artifact-shapes)
- [Things never to do](#things-never-to-do)

## Session Model

Each crawl session is one pass of `(auth state → crawl → form discovery → API capture)`. A multi-session run produces:

- One **anonymous session** (`sessionId = "anonymous"`, `mode = "anonymous"`, `webRoleLabel = "anonymous"`).
- Zero or more **authenticated sessions**, one per web role the user logs in as (`sessionId = "role:<label>"`, `mode = "authenticated"`, `webRoleLabel = "<label>"`).

The session list is `sessions[]` in `runtime-discovery.json`. Routes, forms, and API calls are also aggregated across sessions at the top level so Phase 5 reconciliation can compare against static analysis without per-session iteration; each aggregated entry tracks `seenInSessions[]` / `observedInSessions[]` so role-specific behavior is not lost.

`CRAWL_CAP` (default 25) applies **per session**, not globally. Each authenticated session gets its own quota so a private-only site can still reach `CRAWL_CAP` authenticated routes after the anonymous pass returned zero.

## Step 1: Load the home page and detect auth state

The Playwright MCP launcher already opens the browser at the user's full screen resolution. **Do not** call `browser_resize` — the launcher's maximized window is the correct viewport.

Power Pages sites can have **two independent layers** of authentication. Detect them separately and never conflate them:

1. **Private-site gate** — the entire site is gated by an identity provider (Entra ID, Azure AD B2C, a custom IdP). Navigating to any URL on the site redirects to the IdP host (`login.microsoftonline.com`, `*.b2clogin.com`, etc.) before any site content renders. Passing the gate makes the site reachable but **does not sign the user into the portal** — they are still anonymous from a Power Pages perspective (their effective web role is `Anonymous Users`).
2. **Site-level sign-in** — the site is reachable (the gate, if any, is cleared) and renders a "Sign in" / "Log in" / "Register" link in the navigation. Clicking that link triggers a second login that authenticates the user as a Power Pages contact and applies their web roles (`Administrators`, `C1 Admin`, `Authenticated Users`, etc.).

A site may have only Layer 1, only Layer 2, both, or neither. The role-label question in the SKILL's orchestration applies **only to Layer 2 sign-in** — passing the Layer 1 gate never produces a role-bearing session.

### 1.1 Load the home page

For the first session (anonymous):

1. `browser_navigate` to `LIVE_SITE_URL`.
2. `browser_wait_for` 5 seconds for client-side rendering.
3. `browser_snapshot` to capture the accessibility tree.
4. `browser_console_messages` at level `error` to record JavaScript errors.
5. `browser_network_requests` with `includeStatic: false` to capture the initial API surface.

For each subsequent authenticated session, the browser is already on the live site **and already past the Layer 2 sign-in**. Do not navigate through the identity provider or click "Sign in" yourself. If the snapshot shows the browser fell back to a gate or sign-in screen, abort the session (see the table below).

### 1.2 Detect Layer 1 (private-site gate)

Look at the snapshot URL and content:

- URL changed to an IdP host (`login.microsoftonline.com`, `*.b2clogin.com`, a custom IdP) → **gate detected**, `cleared: false`.
- Page renders an IdP login form / account picker before any site content → **gate detected**.
- 401/403 returned before site content loaded → **gate detected**.
- URL still on the `LIVE_SITE_URL` host and site content rendered → **gate is either absent or already cleared** (e.g., browser already has IdP cookies from a prior session).

Record on the top-level `auth` block:

```json
{
  "privateSiteGate": {
    "detected": true,
    "cleared": false,
    "providerDomain": "login.microsoftonline.com",
    "signInUrl": "<full gate URL>",
    "returnUrlShape": "<return URL pattern>"
  }
}
```

When the gate is detected, the orchestrating SKILL pauses to ask the user to clear it (see SKILL Phase 4.4.b). After the user confirms and `browser_snapshot` shows the URL back on `LIVE_SITE_URL`, set `cleared: true` and continue with the anonymous crawl. **Passing the gate is a precondition, not a session boundary.** The current session remains `mode: "anonymous"` and its `detectedAuthState` stays `"anonymous"` — gate passage alone does not produce a portal sign-in.

### 1.3 Detect Layer 2 (site-level sign-in affordance)

After the home page is reachable (no gate, or gate cleared), look at the rendered navigation:

- A "Sign in" / "Log in" / "Register" link or button visible in the header or AppShell → **site-level auth offered**.
- Pages that show "You must be signed in to view this page" or similar restricted-access messaging → **site-level auth offered**.
- No sign-in affordance anywhere → site is fully anonymous on its public surface; no Layer 2 sign-in is available.

Record on the top-level `auth` block:

```json
{
  "siteLevelSignIn": {
    "detected": true,
    "signInLink": "/SignIn",
    "registerLink": "/Register"
  }
}
```

### 1.4 Per-session auth state cross-check

The session's `detectedAuthState` is the **portal** auth state, not the gate state. Possible values:

- `anonymous` — no portal sign-in. Used for the anonymous pass (whether or not a Layer 1 gate was cleared).
- `signed-in` — portal sign-in present (user name visible, "Sign out" link, role-gated nav). Used for authenticated passes.

Cross-check against the session's intended `mode`:

| Snapshot shows | `mode = anonymous` | `mode = authenticated` |
|----------------|--------------------|------------------------|
| Site content rendered, no sign-in link, no user name | Valid (`detectedAuthState: "anonymous"`) | **Abort** — write `crawlAborted: true`, `abortReason: "browser is anonymous; portal sign-in expected"`. |
| Site content rendered, sign-in link visible in nav | Valid (`detectedAuthState: "anonymous"`); also flag `auth.siteLevelSignIn.detected: true` so the SKILL can offer Layer 2 next | **Abort** — same reason as above. |
| Identity-provider screen visible (Layer 1 gate) | The SKILL must clear the gate before the anonymous crawl proceeds (see 1.2). | **Abort** — write `abortReason: "browser fell back to private-site gate during authenticated pass"`. |
| Signed-in UI visible (user name, sign-out link) | Record `caveats: ["unexpected-signed-in-state"]` and continue as anonymous-equivalent — this usually means cookies from a prior session leaked in | Valid (`detectedAuthState: "signed-in"`). |

## Step 2: Per-page crawl loop

Use `browser_evaluate` to extract same-origin links from the current rendered DOM. Crawl up to `CRAWL_CAP` pages **for this session**. For each page, in order:

1. `browser_navigate` to the URL.
2. `browser_wait_for` 3 seconds.
3. `browser_snapshot` and store a concise summary (main heading, key sections, visible CTAs, any error indicators).
4. `browser_console_messages` (level `error`) — record errors.
5. `browser_network_requests` (`includeStatic: false`) — capture every `/_api/`, OData, and other backend call.
6. `browser_evaluate` to extract any new same-origin links and append them to the session's queue.

Per-route record fields:

- `url`, `route` (path with query stripped), `title`.
- `snapshotSummary` — short description of what is on the page.
- `consoleErrors[]`.
- `networkCalls[]` — see [Step 4](#step-4-api-surface-aggregation) for the per-call shape.
- `redirects[]` — any 3xx chain observed.
- `authGated` — `true` if the page redirected to an identity provider or rendered an "Access denied" / "Please sign in" message **within this session**.
- `hiddenFromSitemap` — `true` if the URL was discovered only via a non-nav link.

When the session ends, finalize the `sessions[]` entry by setting `endedAt`, `routesCrawled`, and `formsObserved.length`. Merge into the top-level aggregates: for every route, push it into the top-level `routes[]` (deduped by `route`) and add the current `sessionId` to its `seenInSessions[]`. Same for `apiCalls[]` (deduped by `(method, url-template)`).

Routes that are `authGated: true` in the anonymous session but reachable in an authenticated session expose role-gated behavior — Phase 5 uses the difference to drive `/setup-auth` and `/create-webroles` scoping.

## Step 3: Form discovery and SPA contract

This is the highest-fidelity part of runtime discovery. EDM forms are server-rendered, so the network shape that a form produces today is the only reliable evidence for what the SPA's client-side form must POST/PATCH against.

### 3.1 Capture the form's static shape

Use `browser_evaluate` on every page that contains a form (look for `<form>` elements and submit buttons in the snapshot):

```js
() => {
  return [...document.querySelectorAll('form')].map(form => ({
    id: form.id || null,
    name: form.getAttribute('name') || null,
    action: form.getAttribute('action') || null,
    method: (form.getAttribute('method') || 'GET').toUpperCase(),
    fields: [...form.elements]
      .filter(el => el.name && el.type !== 'submit' && el.type !== 'button')
      .map(el => ({
        name: el.name,
        type: el.type || el.tagName.toLowerCase(),
        required: el.required || false,
        label: (form.querySelector(`label[for="${el.id}"]`)?.innerText || '').trim() || null,
      })),
    submitButtons: [...form.querySelectorAll('button[type="submit"], input[type="submit"]')]
      .map(b => b.value || b.innerText || null),
  }));
}
```

### 3.2 Decide whether to submit the form

Branch on `INTERACTIONS_MODE`:

- `read-only` — **do not submit**. Record `submitNetwork: null` and a note that the network shape was inferred only from page load. Static analyzer's form classification (table, fields, attachments) is the primary contract.
- `skip-forms` — skip form analysis entirely for the page.
- `submit-synthetic` — generate synthetic field values per the rules below and submit. The agent generates the data itself — the user does **not** supply per-form payloads. Phase 0's environment confirmation already established that the source is a dev tenant with disposable data.

When submitting under `submit-synthetic`:

1. Generate a synthetic value for every **required** field per the type table below. Leave optional fields empty unless the form's classification (e.g., a profile editor with mostly-optional fields) suggests filling them all.
2. Fill the form via `browser_evaluate`.
3. `browser_click` the submit button.
4. `browser_wait_for` 5 seconds for the request to settle.
5. `browser_network_requests` (`includeStatic: false`) — find the POST/PATCH and capture it (Step 4 shape).

#### Synthetic-data generation rules

Every synthetic value must be **obviously a test record** so the user can find and delete it later. Use a stable per-run marker like `MigrationTest-<YYYY-MM-DD-HH-mm>` and include it (or a recognizable variant) in at least one field of every submission.

| Field type | Synthetic value |
|------------|-----------------|
| `text` / `string` (generic) | `MigrationTest <FieldLabel>` (e.g. `MigrationTest Subject`) |
| First name / given name | `MigrationTest` |
| Last name / family name / surname | `Synthetic-<YYYY-MM-DD>` |
| `email` | `migration-test+<unix-timestamp>@example.com` (uses the IETF-reserved `example.com` domain) |
| `phone` / `tel` / mobile | `+1-555-0100` (the US `555-0100`-`555-0199` block is reserved for fictional use; see [RFC 3092](https://datatracker.ietf.org/doc/html/rfc3092) tradition and the NANP fictional-number reservation) |
| `url` | `https://example.com/migration-test` |
| `number` (integer) | `1` |
| `number` (decimal, currency) | `0.00` |
| `date` | today's date in the form's expected format |
| `datetime` | today's date at `12:00:00` UTC |
| `textarea` / multiline | `Synthetic test submission generated by /migrate-traditional-site-to-spa-analyze on <ISO 8601>. Safe to delete.` |
| `select` / dropdown / radio | First non-empty option (or first option whose label does not start with "Select…", "Choose…", etc.) |
| `checkbox` (required, e.g. consent) | `true` |
| `checkbox` (optional) | `false` |
| `file` upload | Skip — record `caveats: ["attachments-not-tested-in-synthetic-mode"]` instead of attempting an upload |
| CAPTCHA | Cannot be solved by the agent — record `caveats: ["captcha"]` and skip submission for this form; record `submitNetwork: null`. |
| Any field with a regex / pattern validator | Try the type-based default first; if it fails validation (visible in the post-submit snapshot or response), capture the validation-error shape and record `caveats: ["validation-rejected-synthetic"]` — that is itself useful network evidence |

#### Forms the agent must not submit even under `submit-synthetic`

Skip submission (capture static shape + `submitNetwork: null`) for these patterns regardless of mode:

1. **Edit / Update mode forms** (PATCH against an existing record). Modifying the signed-in user's contact or any pre-existing row can break referenced state (role assignments, table permissions, downstream workflows). Capture the form's static shape only.
2. **Forms that target sensitive tables**: `systemuser`, `team`, `role`, `solution`, `organization`, anything matching `^Microsoft\.` schema prefix.
3. **Forms with file-upload required fields** — skip (see the `file` row above).
4. **Forms with unresolved CAPTCHA** — skip (see the `CAPTCHA` row above).
5. **Forms where the static analyzer flagged `manualGap` in `forms-inventory.json`** — those are already known to be unsafe to drive client-side.

For each skipped form, record the reason in `caveats[]` so Phase 5 sees the network-shape gap and the migrated SPA contract gets marked `confidence: "medium"`.

### 3.3 Per-form record

Tag each form record with `observedInSessions[]` so role-gated forms can be distinguished from anonymous forms in Phase 5. If the same form appears in multiple sessions, merge into a single record with all session ids in `observedInSessions[]` — never emit duplicates.

```json
{
  "formId": "<form id or synthesized id>",
  "pageRoute": "/contact-us",
  "static": {
    "action": "/contact-us/",
    "method": "POST",
    "fields": [
      { "name": "firstname", "type": "text", "required": true, "label": "First name" }
    ]
  },
  "submitNetwork": {
    "url": "https://<host>/_api/contacts",
    "method": "POST",
    "requestHeaders": ["__RequestVerificationToken"],
    "payloadShape": {
      "firstname": "<string>",
      "lastname": "<string>",
      "emailaddress1": "<string>"
    },
    "responseStatus": 204,
    "redirectAfter": "/thank-you/",
    "validationErrorShape": null
  },
  "spaContract": {
    "webApiEndpoint": "POST /_api/contacts",
    "entitySetName": "contacts",
    "fields": [
      { "name": "firstname", "type": "string", "required": true },
      { "name": "lastname", "type": "string", "required": true },
      { "name": "emailaddress1", "type": "string", "required": true, "validation": "email" }
    ],
    "successBehavior": "navigate(/thank-you)",
    "requiredService": "/integrate-webapi:contact"
  },
  "confidence": "high",
  "observedInSessions": ["anonymous"],
  "evidence": ["url:/contact-us/", "networkRequest:POST /_api/contacts"]
}
```

When `submitNetwork` is `null` (read-only mode), still write `spaContract` based on the static field set and the table inferred from the form's `action`. Mark these entries `confidence: "medium"`.

### 3.4 Special form behaviors

Flag in `caveats[]` regardless of interactions mode:

- **CAPTCHA** (`g-recaptcha`, `h-captcha`, custom portal CAPTCHA divs) → `caveats: ["captcha"]`, lower confidence.
- **File upload** (`<input type="file">`) → `caveats: ["attachments"]`, capture accepted file types + max size when visible.
- **Multi-step / wizard navigation** → `caveats: ["multi-step"]`, capture step labels + progress UI.
- **Anti-forgery token** (`__RequestVerificationToken`) → `caveats: ["anti-forgery-token"]` (every Power Pages form has one; the SPA replacement must obtain it via `/_layout/tokenhtml`).
- **Server-side validation messages** rendered on submit → record one example so the SPA replacement preserves the text and placement.

## Step 4: API surface aggregation

Across all crawled pages **and all sessions**, aggregate every backend network call (excluding static assets):

```json
{
  "url": "https://<host>/_api/faq_topics?$select=name,description",
  "method": "GET",
  "observedOn": ["/", "/faq/"],
  "observedInSessions": ["anonymous", "role:Authenticated Users"],
  "payloadShape": null,
  "responseShape": { "value": [{ "name": "<string>", "description": "<string>" }] },
  "frequency": 4
}
```

Group by `(method, url-template)` to dedupe. Capture OData query parameters separately (`$select`, `$expand`, `$filter`, `$top`, `$orderby`) so the static analyzer's data model can be cross-checked. Populate `observedInSessions[]` with every session that issued the request — calls visible only to authenticated sessions surface role-gated endpoints that Phase 5 must scope behind table permissions.

Flag any call that hits an endpoint other than `/_api/`, `/_layout/tokenhtml`, `/_services/`, or the site's own pages — these are likely external integrations and become `manualGapCandidates[]` in Phase 5.

## Step 5: Compare runtime against static (best-effort)

If `EDM_SOURCE_ROOT` was provided and the static analyzer's `static-analysis.json` exists by the end of the multi-session crawl, do a best-effort comparison:

- Routes seen at runtime but missing from `static-analysis.json:pages[]`.
- Static pages whose route never appeared in any crawl (likely auth-gated and not exercised, or unlinked).
- Forms in the static inventory whose target table did not match any observed network endpoint → mark `confidence: medium` and add a note.
- Runtime API calls that have no obvious static-source counterpart → write a `runtime-only-api` note so the static analyzer's custom-JS classification gets revisited.

If `static-analysis.json` is not yet written when the runtime crawl finishes, skip the comparison and note the skip in `runtime-discovery-summary.md`. Phase 5 will do a full reconciliation regardless.

## Artifact shapes

Write three artifacts under `<TARGET_PROJECT_ROOT>/migration-artifacts/`:

### `runtime-discovery.json`

```json
{
  "version": "1.1",
  "liveSiteUrl": "<LIVE_SITE_URL>",
  "crawlCap": 25,
  "interactionsMode": "read-only",
  "status": "complete",
  "summary": {
    "sessionsRun": 3,
    "anonymousRoutes": 12,
    "authenticatedRoutes": 9,
    "formsObserved": 4,
    "apiCallsObserved": 17,
    "consoleErrors": 2
  },
  "auth": {
    "privateSiteGate": {
      "detected": true,
      "cleared": true,
      "providerDomain": "login.microsoftonline.com",
      "signInUrl": "<full gate URL>",
      "returnUrlShape": "<return URL pattern>"
    },
    "siteLevelSignIn": {
      "detected": true,
      "signInLink": "/SignIn",
      "registerLink": "/Register"
    },
    "userDeclinedAuthenticatedPasses": false
  },
  "sessions": [
    {
      "sessionId": "anonymous",
      "mode": "anonymous",
      "webRoleLabel": "anonymous",
      "detectedAuthState": "anonymous",
      "authIdentity": null,
      "startedAt": "<iso8601>",
      "endedAt": "<iso8601>",
      "routesCrawled": 0,
      "formsObserved": 0,
      "routes": [],
      "consoleErrors": [],
      "networkCalls": []
    },
    {
      "sessionId": "role:Authenticated Users",
      "mode": "authenticated",
      "webRoleLabel": "Authenticated Users",
      "detectedAuthState": "signed-in",
      "authIdentity": "Jane Doe",
      "startedAt": "<iso8601>",
      "endedAt": "<iso8601>",
      "routesCrawled": 12,
      "formsObserved": 3,
      "routes": ["…per-session route records…"],
      "consoleErrors": ["…"],
      "networkCalls": ["…"]
    }
  ],
  "routes": ["…aggregated routes with seenInSessions[]…"],
  "apiCalls": ["…aggregated calls with observedInSessions[]…"],
  "consoleErrors": ["…aggregated…"],
  "interactions": ["…approved form submissions, if any…"],
  "staticRuntimeMismatch": ["…optional, written only when comparison ran…"]
}
```

`status` is one of `complete`, `cancelled-by-user`, or `skipped`. The SKILL flips it after the multi-session loop ends — during a session, leave it `"in-progress"`.

When `LIVE_SITE_URL` is missing, write `{ "version": "1.1", "status": "skipped", "reason": "no LIVE_SITE_URL provided", "sessions": [] }` and exit Phase 4 without launching the browser.

### `runtime-forms.json`

Array of form records as shown in Step 3.3. Deduped across sessions by `(pageRoute, formId)` with `observedInSessions[]` unioned across passes.

### `runtime-discovery-summary.md`

Human-readable summary. Cumulative across sessions — each new session appends a section (route counts, observed forms, observed auth state) and updates a top-level "Sessions run so far" header. The parent SKILL relies on this when summarizing for Phase 6's HTML plan.

## Things never to do

- **Do not log in for the user.** The SKILL prompts the user to log in via the browser window and verifies the resulting state with `browser_snapshot`. Never type into login fields, click "Sign in" buttons that lead to an identity provider, or follow auth redirects programmatically.
- **Do not close the browser between sessions.** The browser stays alive across the whole multi-session loop so the user's signed-in state survives between role passes. Call `browser_close` only in the SKILL's finalize step, after the user is done with all passes.
- **Do not persist sensitive identity material in any artifact.** Capture only a short non-sensitive role label and an optional display name — never tokens, cookies, email addresses, or anything that would leak credentials when the artifacts are checked into the user's repo.
- **Do not call `browser_resize`.** The launcher opens the window maximized at the user's screen resolution; resizing shrinks it.
- **Do not classify forms or templates by hand.** Record the runtime evidence (URL, payload, response, redirect). The static analyzer is responsible for the Form Conversion Standards classification; Phase 5 reconciles the two.
- **Do not skip OData / Web API request capture.** The `apiCalls[]` and `runtime-forms.json` outputs are the SPA's only reliable contract source.
