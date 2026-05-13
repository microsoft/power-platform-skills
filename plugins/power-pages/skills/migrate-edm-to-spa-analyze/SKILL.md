---
name: migrate-edm-to-spa-analyze
description: >-
  Analyzes a classic Enhanced Data Model (EDM) Power Pages website and produces an approved
  migration plan that `migrate-edm-to-spa-implement` consumes. Phases 1-6 of the migration workflow:
  resolve source, pre-flight readiness, static EDM analysis, runtime discovery, build canonical
  model and verification checklist, render the HTML migration plan and capture user approval.
  Invoked directly by `migrate-edm-to-spa` (the meta skill) or standalone when the user wants only
  the analysis phase. Intended for development environments only — Phase 4 can submit real forms
  to the source's Dataverse if `submit-synthetic` interactions mode is chosen.
user-invocable: true
argument-hint: "<website-id-or-downloaded-site-path>"
allowed-tools: Read, Write, Edit, Bash, Grep, Glob, AskUserQuestion, Task, TaskCreate, TaskUpdate, TaskList, Skill, mcp__plugin_power-pages_playwright__browser_navigate, mcp__plugin_power-pages_playwright__browser_snapshot, mcp__plugin_power-pages_playwright__browser_click, mcp__plugin_power-pages_playwright__browser_close, mcp__plugin_power-pages_playwright__browser_network_requests, mcp__plugin_power-pages_playwright__browser_console_messages, mcp__plugin_power-pages_playwright__browser_wait_for, mcp__plugin_power-pages_playwright__browser_resize, mcp__plugin_power-pages_playwright__browser_evaluate
model: opus
---

> **Plugin check**: Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/check-version.js"` — if it outputs a message, show it to the user before proceeding.

# Analyze EDM Site for SPA Migration

> ## ⚠️ Use a development environment only
>
> Phase 4 crawls the live source site in your browser. If `INTERACTIONS_MODE` is `submit-synthetic`, the agent generates synthetic form payloads and submits them — this creates real records (contacts, cases, etc.) against the **source's Dataverse**. Even in `read-only` mode, every page load triggers the portal's own GET requests against the source.
>
> Point this skill at a **development tenant** for the source EDM site. Do not crawl a production portal unless you fully understand which interactions will be triggered and have explicit approval from whoever owns the data.

Phase 1-6 of the EDM-to-SPA migration workflow. Discovers the EDM source, observes runtime behavior, builds an explainable migration model, and renders manual gaps into an approval-gated HTML plan. Produces the `migration-artifacts/` folder that `migrate-edm-to-spa-implement` consumes.

## Core Principles

- **Evidence before generation**: produce no SPA files in this skill — only artifacts under `migration-artifacts/`.
- **Migration is re-authoring, not blind conversion**: every EDM route, Liquid behavior, form, and runtime call must map to an explicit SPA target with a `targetKind` (`component`, `content`, `webApi`, `serverLogic`, `staticAsset`, `manualGap`).
- **Explain every inference**: every migrated entry must trace back to static evidence, runtime evidence, or both via the evidence ledger.
- **Preserve user control**: ask before downloading the EDM site, logging in through the browser, or testing destructive form actions. The HTML plan in Phase 6 is the single user-approval surface.

**Initial request:** $ARGUMENTS

> **Prerequisites:**
>
> - Either a Power Pages website record ID (downloadable with `pac pages download`) or an existing PAC-downloaded EDM site directory.
> - A target static SPA framework: React, Vue, Angular, or Astro.
> - Strongly recommended: the live site URL for Playwright runtime discovery.

---

## Workflow

0. **Confirm Development Environment** — Show the source-environment warning to the user and gate progress with `AskUserQuestion`. Phase 1 only runs after explicit acknowledgement.
1. **Resolve Migration Source** — Inputs: website record ID or downloaded source, framework, output path, optional live URL.
2. **Pre-flight Readiness** — Validate PAC shape, score complexity, flag unsupported / high-risk patterns.
3. **Static EDM Analysis** — Delegate to `migration-static-analyzer` (parallel with Phase 4).
4. **Runtime Discovery** — Drive the multi-session Playwright crawl **in the main agent** (parallel with Phase 3). Runtime discovery is not delegated to a subagent because subagents cannot use `AskUserQuestion`, which the login/role-switch flow needs.
5. **Build Migration Model and Verification Checklist** — Reconcile both agents' artifacts into the canonical model and the falsifiable checklist Phase 8 will validate against.
6. **Review Migration Plan** — Render the HTML plan, capture user approval, write `analyze-complete.json` so the implement skill knows analysis is done.

---

## Phase 0: Confirm Development Environment

**Goal:** Make sure the user has seen and acknowledged the source-environment warning before any work starts. This is a hard gate — without explicit acknowledgement, Phase 1 must not run.

### Actions

Display the dev-environment warning to the user **as a chat message** (not just as a SKILL.md callout — the user will not see the SKILL.md). Use this text verbatim:

> ⚠️ **Use a development environment only.** This skill crawls the live EDM source site in your browser. Even in read-only mode, every page load triggers GET requests against the source's Dataverse. If you choose to submit forms during the runtime crawl (Phase 4.2), the agent generates synthetic test data and submits it — **this creates real records** (contacts, cases, etc.) in the source's Dataverse.
>
> The follow-on implement skill (Phase 7) deploys, activates a public URL, and writes table permissions / web roles / site settings / server logic to the target Dataverse tenant.
>
> Run this against **development tenants** only. Validate the full migration end-to-end in dev before pointing it at production.

Then gate progress with `AskUserQuestion`:

| Header | Question | Options |
|--------|----------|---------|
| Dev environment? | Confirm the source EDM site you're about to migrate is in a **development environment** (not a production portal). Synthetic form submissions, page-load GET traffic, and any downloads will hit that environment. | Yes — source is a dev environment, Cancel — I'll switch environments first |

On **Cancel** → stop immediately. Tell the user they can re-invoke the skill after switching to a dev tenant. Do not proceed to Phase 1.

On **Yes** → proceed to Phase 1.

If this skill was invoked by `migrate-edm-to-spa` (the meta skill), the gate still fires here — the meta does not pre-confirm. The user sees the warning at the entry point of analyze regardless of how analyze was invoked.

---

## Phase 1: Resolve Migration Source

**Goal:** Identify the EDM source, target SPA framework, output location, and runtime discovery options.

### Actions

#### 1.1 Create Task List

Create the full task list with all 7 phases (Phase 0 through Phase 6 — see [Progress Tracking](#progress-tracking)). Phase 0 should already be marked `completed` (it ran before Phase 1 reached this step). Mark Phase 1 `in_progress`.

#### 1.2 Gather Migration Inputs

If `$ARGUMENTS` is a UUID, treat it as the website record ID. If it is an existing path, treat it as `EDM_SOURCE_ROOT`. Otherwise ask:

| Question | Options |
|----------|---------|
| How should I get the EDM source? | Download by website record ID, Use an already downloaded directory |
| Which static SPA framework should the migrated site use? | React (Recommended), Vue, Angular, Astro |
| Where should the migrated SPA be created? | New folder in current directory (Recommended), Existing empty directory, Other directory |
| Do you have the live site URL for runtime discovery? | I'll provide it, Skip runtime discovery for now |

For download mode, ask **only** for the website record ID — Phase 1.3 creates a fresh OS temp directory so there is nothing to overwrite.

Store: `EDM_SOURCE_MODE`, `WEBSITE_RECORD_ID`, `EDM_SOURCE_ROOT`, `TARGET_FRAMEWORK`, `TARGET_PROJECT_ROOT`, `LIVE_SITE_URL`.

#### 1.3 Download the EDM Site When Needed

If the user chose download mode, confirm `pac` is authenticated, then create a fresh OS temp directory (cross-platform):

```bash
node -e "const fs=require('fs'),os=require('os'),path=require('path');console.log(fs.mkdtempSync(path.join(os.tmpdir(),'edm-source-')))"
```

Capture the printed path as `EDM_SOURCE_ROOT`, then run:

```bash
pac pages download --webSiteId "<WEBSITE_RECORD_ID>" --path "<EDM_SOURCE_ROOT>" --modelVersion 2
```

Tell the user where the source was downloaded. If the command fails, surface the error and ask whether to retry, provide an existing directory, or stop.

#### 1.4 Locate the Website Data Root

The EDM root typically contains `website.yml` plus subfolders like `web-pages/`, `web-templates/`, `content-snippets/`, `web-files/`, `lists/`, `basic-forms/`, `table-permissions/`, `webrole.yml`, `sitesetting.yml`. If the directory shape is unclear, read `${CLAUDE_PLUGIN_ROOT}/skills/migrate-edm-to-spa/references/pac-edm-structure.md` and confirm the correct root with the user.

### Output

- EDM source root, target framework, and target project root confirmed.
- Live URL captured (or runtime confidence marked as limited).

---

## Phase 2: Pre-flight Readiness

**Goal:** Decide whether the migration is feasible and identify risk before deep analysis.

### Actions

#### 2.1 Load PAC Structure Guidance

Read `${CLAUDE_PLUGIN_ROOT}/skills/migrate-edm-to-spa/references/pac-edm-structure.md` and use it to validate the source shape and identify relevant PAC record groups.

#### 2.2 Build a Source Inventory

Use `Glob` / `Read` to count and sample every PAC record group listed in the structure reference (web pages, templates, snippets, web files, lists, basic/advanced forms, table permissions, web roles, site settings, navigation records).

#### 2.3 Detect High-Risk Patterns

Flag findings with `low` / `medium` / `high` risk:

| Risk | Examples |
|------|----------|
| Heavy Liquid logic | Deep includes, conditionals, loops, FetchXML, server-side decisions controlling UI/data |
| Complex Dataverse behavior | Entity lists/forms with embedded JSON actions, advanced forms, custom redirects, multistep flows, attachment handling |
| Security-sensitive behavior | Role-gated pages, Contact/Account/Parent table-permission scopes, profile settings, auth provider settings |
| Hidden runtime behavior | Custom JS, jQuery validators, portal runtime globals, non-obvious redirects |
| Unsupported / manual | Forums, blogs, polls, KM search/facets, portal comments, internal portal APIs, custom widgets |

#### 2.4 Capture Readiness Findings

Save a concise readiness summary to `migration-artifacts/static-analysis-summary.md` (overwritten later by the static analyzer) and feed high-risk findings into the canonical model's `unsupportedOrManual[]` so they become `GAPS_DATA` in Phase 6. Do **not** open a CLI gap-approval prompt at this stage — the HTML plan in Phase 6 is the review surface.

Use the table shape `Area | Count/Finding | Risk | Notes` covering web pages, templates, lists/forms, Liquid/custom JS, security/auth, and unsupported patterns.

### Output

- Readiness score and risk list captured for `migration-gap-log.md` and Phase 6's HTML plan.

---

## Phase 3: Static EDM Analysis

**Goal:** Produce a complete, evidence-backed inventory and classification of the downloaded EDM site by delegating to `migration-static-analyzer`.

Phase 3 and Phase 4 run **in parallel**. Launch both `Task` calls in the same tool-calling turn; wait for both before advancing to Phase 5.

### Actions

#### 3.1 Confirm Inputs

Verify `EDM_SOURCE_ROOT` (must contain `website.yml`), `TARGET_PROJECT_ROOT` (absolute), `TARGET_FRAMEWORK`, `LIVE_SITE_URL` (optional). Create `TARGET_PROJECT_ROOT` if missing so the agent can write `migration-artifacts/`.

#### 3.2 Delegate to the `migration-static-analyzer` Agent

Use the `Task` tool to invoke the agent at `${CLAUDE_PLUGIN_ROOT}/agents/migration-static-analyzer.md`.

Use the prompt template in `${CLAUDE_PLUGIN_ROOT}/skills/migrate-edm-to-spa/references/agent-prompts.md#static-analyzer-prompt` with substitutions: `EDM_SOURCE_ROOT`, `TARGET_PROJECT_ROOT`, `TARGET_FRAMEWORK`, `LIVE_SITE_URL` (or `'none'`).

Launch this `Task` call in the **same tool-calling turn** as the Phase 4 anonymous-session Playwright work so they run concurrently — the analyzer runs in a subagent while the main agent drives the browser.

#### 3.3 Consume the Static Analyzer's Output

Confirm all four artifacts exist on disk. If any are missing, re-invoke with a corrective prompt or surface the diagnostic. Read at minimum `static-analysis-summary.md`, `forms-inventory.json`, and the `risks[]` section of `static-analysis.json`. Phase 5 reads the JSON artifacts directly — do not re-do the agent's work in the main context.

### Output

- `migration-artifacts/edm-source-inventory.json`, `static-analysis.json`, `forms-inventory.json`, `static-analysis-summary.md`.
- Form classification covering every basic and advanced form, with mandatory mappings never defaulted to `manual-gap`.

---

## Phase 4: Runtime Discovery

**Goal:** Observe the live EDM site directly with Playwright so behavior implicit in the portal runtime (network calls, form submission contracts, auth transitions, hidden routes) is captured as JSON evidence.

This phase **runs in the main agent**, not as a subagent. Subagents cannot use `AskUserQuestion`, which blocks every authenticated-pass flow. The main agent drives the Playwright crawl directly, asking the user to log in between sessions with `AskUserQuestion` and verifying state with `browser_snapshot`.

Phase 4 still runs **in parallel with Phase 3**. Launch the Phase 3 `Task` (static analyzer) and start the Phase 4 anonymous Playwright crawl in the same turn.

> **Per-session crawl procedure** (per-page loop, form discovery, API aggregation, artifact schemas, things never to do) is in:
>
> `${CLAUDE_PLUGIN_ROOT}/skills/migrate-edm-to-spa/references/runtime-discovery-procedure.md`
>
> Read it before starting the first session. The orchestration below tells you *when* to run each crawl; the procedure reference tells you *what* to do during one.

### Two-Layer Auth Model

Power Pages sites can have **two independent and optional layers** of authentication. Detect them separately — never conflate.

1. **Private-site gate** (Layer 1) — the whole site is gated by an identity provider (Entra ID, Azure AD B2C, custom IdP). Browser redirects to the IdP host on initial navigation. Passing the gate makes the site reachable but **does not** sign the user into the portal — they remain anonymous from a Power Pages perspective (effective web role: `Anonymous Users`).
2. **Site-level sign-in** (Layer 2) — a "Sign in" / "Log in" / "Register" link in the site navigation. Clicking it triggers a second login that authenticates the user as a Power Pages contact and applies their web roles (`Administrators`, `Authenticated Users`, etc.).

Either layer may be present or absent independently — there are four combinations:

| Layer 1 (gate) | Layer 2 (site sign-in) | Example site |
|----------------|------------------------|--------------|
| Absent | Absent | Fully public marketing portal — only an anonymous session is meaningful |
| Absent | Present | Public-facing portal with optional sign-in — anonymous session + offer Layer 2 |
| Present | Absent | Tenant-internal site where everyone is portal-anonymous — clear gate, then run anonymous session only |
| Present | Present | Tenant-internal site with per-user roles — clear gate, run anonymous session, then offer Layer 2 |

**The role-label question applies only to Layer 2 sign-in.** Passing the Layer 1 gate never produces a role-bearing session.

### Actions

#### 4.1 Confirm Runtime Scope

If `LIVE_SITE_URL` is missing:

| Question | Options |
|----------|---------|
| Runtime discovery works best against the live EDM site. What should I do? | Provide live URL, Continue static-only (limited confidence), Stop |

If the user chooses static-only, skip 4.2-4.8, write `runtime-discovery.json` containing `{ "version": "1.1", "status": "skipped", "reason": "user chose static-only", "sessions": [] }` and a one-line `runtime-discovery-summary.md` recording the skip, then continue to Phase 5.

#### 4.2 Capture Interactions Mode

| Question | Options |
|----------|---------|
| The runtime crawl can interact with forms on the live site. How should it handle forms? | Read-only — never submit (Recommended), Submit with agent-generated synthetic data, Skip forms entirely |

Store as `INTERACTIONS_MODE` (`read-only` / `submit-synthetic` / `skip-forms`).

> **⚠️** `Submit with agent-generated synthetic data` writes real records to the source's Dataverse (contacts, cases, etc.). The agent generates the field values itself — it does **not** ask you for each form's payload. Defaults are designed to be obviously synthetic and findable (e.g., `migration-test+<timestamp>@example.com`, `MigrationTest <FieldLabel>`, `+1-555-0100`) so you can delete the test records afterward. Use only against a development environment with disposable data. `Read-only` is the safe default unless you specifically need the network-shape evidence from form submissions.

#### 4.3 Derive the Web Roles Hint

Read `webrole.yml` in `<EDM_SOURCE_ROOT>` and extract every `adx_name`. The resulting list (typically `["Authenticated Users", "Anonymous Users", <custom roles>]`) drives the role-label prompt in 4.6. If `EDM_SOURCE_ROOT` is unavailable, treat the hint as `[]`.

#### 4.4 Run the Anonymous Session

##### 4.4.a Initialize artifacts and load the home page

Initialize `<TARGET_PROJECT_ROOT>/migration-artifacts/runtime-discovery.json` with the empty top-level shape from the procedure reference's [Artifact shapes](runtime-discovery-procedure.md#artifact-shapes) section (`status: "in-progress"`, empty `sessions[]`, `auth.privateSiteGate` and `auth.siteLevelSignIn` blocks initialized with `detected: false`).

Launch the Phase 3 static analyzer `Task` and start the Playwright work in the **same tool-calling turn** so they run concurrently.

Perform Step 1.1 of the procedure reference (navigate to `LIVE_SITE_URL`, wait, snapshot, console messages, network requests).

##### 4.4.b Detect Layer 1 (private-site gate) and clear it if present

Examine the snapshot URL and content per procedure Step 1.2.

- **No gate** — URL still on `LIVE_SITE_URL` host and site content visible. Set `auth.privateSiteGate.detected: false`. Skip to 4.4.c.
- **Gate detected** — URL on IdP host, or IdP login form visible. Record `auth.privateSiteGate.detected: true`, `auth.privateSiteGate.providerDomain`, `auth.privateSiteGate.signInUrl`, `auth.privateSiteGate.returnUrlShape`, `auth.privateSiteGate.cleared: false`.

If the gate is detected, pause with `AskUserQuestion`:

| Header | Question | Options |
|--------|----------|---------|
| Private-site gate | The site is private — it redirected to `<providerDomain>` before any content could load. A browser window is open showing the IdP sign-in page. **This is the access gate, not the portal sign-in** — passing it does not sign you into the Power Pages site; you'll still be anonymous from the portal's perspective. Please complete the IdP sign-in in the browser. Once you can see the site homepage on `<LIVE_SITE_URL>`, choose "I've cleared the gate". | I've cleared the gate (Recommended), Cancel runtime discovery |

On "I've cleared the gate":

1. `browser_snapshot` to verify the URL is back on the `LIVE_SITE_URL` host (not the IdP host) and site content is visible.
2. If still on the IdP host, re-ask up to 3 times with the message `"It looks like the gate sign-in hasn't completed yet. Please finish the IdP login and try again."`. On the 3rd failure, treat as Cancel.
3. Once verified, set `auth.privateSiteGate.cleared: true`. **Clearing the gate is a precondition, not a session boundary.** The anonymous session has not yet started crawling — proceed to 4.4.c.

On "Cancel runtime discovery": close the browser, set `status: "cancelled-by-user"`, continue to Phase 5 with whatever the static analyzer produced.

##### 4.4.c Append the anonymous session and run the crawl

Append the first `sessions[]` entry with `sessionId = "anonymous"`, `mode = "anonymous"`, `webRoleLabel = "anonymous"`, `startedAt`, `detectedAuthState = "anonymous"`.

Run the per-session crawl per the procedure reference — Step 1.4 cross-check (the browser may show a "Sign in" link, which means Layer 2 exists; that does **not** change the anonymous session's state), Step 2 (per-page crawl loop up to `CRAWL_CAP = 25`), Step 3 (form discovery and SPA contract), Step 4 (API surface aggregation).

When the anonymous session completes, finalize its `sessions[]` entry (`endedAt`, `routesCrawled`, etc.) and merge into the top-level aggregates.

##### 4.4.d Detect Layer 2 (site-level sign-in affordance)

Inspect the rendered navigation per procedure Step 1.3:

- A "Sign in" / "Log in" / "Register" link or button visible in the header / AppShell → `auth.siteLevelSignIn.detected: true`. Record `signInLink` and `registerLink` URLs if present. Offer Layer 2 in 4.5.
- No sign-in affordance → `auth.siteLevelSignIn.detected: false`. The site has no per-user portal sign-in; skip to 4.9. The Phase 5 model treats this as anonymous-only, even if Layer 1 was present (a private but per-user-anonymous site).

#### 4.5 Offer a Site-Level Authenticated Pass

This applies only when `auth.siteLevelSignIn.detected: true`. Use `AskUserQuestion`:

| Header | Question | Options |
|--------|----------|---------|
| Site-level sign-in | The anonymous session crawled `<routesCrawled>` routes. A "Sign in" link is visible in the site navigation — this is **separate from the private-site gate** and signs you into the Power Pages site itself with a specific web role. To capture role-gated routes/forms/APIs, click "Sign in" in the open browser window and log in with a portal account that has the role you want to explore. Hint — roles from `webrole.yml`: `<comma-separated list or "no hint available">`. When the site shows your user name (replacing the "Sign in" link), choose "I have signed in". | I have signed in (Recommended), Skip authenticated passes, Cancel runtime discovery |

Branches:

- **I have signed in** → 4.6.
- **Skip authenticated passes** → set `auth.userDeclinedAuthenticatedPasses: true`, skip to 4.9.
- **Cancel runtime discovery** → `browser_close`, set `status: "cancelled-by-user"`, continue to Phase 5 with anonymous-only data.

#### 4.6 Verify the Site-Level Sign-In and Capture the Role Label

1. `browser_snapshot`. Confirm **all** of:
   - URL host is `LIVE_SITE_URL` (not `login.microsoftonline.com`, `*.b2clogin.com`, or a custom IdP host).
   - The "Sign in" / "Log in" link visible in the anonymous snapshot is **gone**.
   - Authenticated UI is visible: user name in nav, "Sign out" link, profile menu, or role-gated nav items absent in the anonymous snapshot.

   If the "Sign in" link is still visible, the portal sign-in did not complete — the user may have only re-passed the gate. Re-ask:

   | Header | Question | Options |
   |--------|----------|---------|
   | Sign-in not complete | The site still shows a "Sign in" link, which means the portal sign-in didn't complete. Click "Sign in" on the site and complete the portal login (this is the second login, after the gate). | I have signed in now, Cancel runtime discovery |

   Cap at 3 retries; on the 3rd failure, treat as Cancel.

2. Capture the role label:

   | Header | Question | Options |
   |--------|----------|---------|
   | Role label | Which web role does the signed-in account exercise? | `<one option per hint role from 4.3>`, Other |

   Use the chosen label as `ROLE_LABEL`. Set `SESSION_ID = "role:<ROLE_LABEL>"`.

#### 4.7 Run the Authenticated Session

Append a new `sessions[]` entry with `SESSION_ID`, `mode = "authenticated"`, `webRoleLabel = <ROLE_LABEL>`, `startedAt`, `detectedAuthState = "signed-in"`.

Run the same per-session crawl from the procedure reference (Steps 2-4 — Step 1.1 is already done since the browser is on the live site). The browser is already past the gate **and** portal-signed-in — do not navigate through the IdP and do not click "Sign in". If the snapshot shows the browser fell back to the gate or to the "Sign in" affordance, write the session record with `crawlAborted: true` and the appropriate `abortReason`, then return to 4.5 to re-prompt.

Forms and API calls merge into `runtime-forms.json` and the top-level `apiCalls[]` aggregate by `(pageRoute, formId)` and `(method, url-template)` respectively, with `observedInSessions[]` unioned across passes.

#### 4.8 Loop: Offer Another Role

| Header | Question | Options |
|--------|----------|---------|
| More roles? | Crawl as a different web role? Sign out of the portal in the open browser window, then sign back in with a different user. When the new account is signed in (site shows the new user's name), choose "Crawl another role". | Crawl another role, Done — finalize runtime discovery |

If "Crawl another role", return to 4.6 (verify the new sign-in, capture the new role label, run another authenticated session via 4.7). The browser stays open between sessions; each new session appends to the existing artifacts.

If the user signs out far enough that the portal returns to the gate (which can happen on some Entra ID flows), the next 4.6 verification will fail. Treat that the same as any other failed sign-in — re-ask up to 3 times and then treat as Cancel for that pass.

#### 4.9 Finalize the Multi-Session Run

1. `browser_close`.
2. Set `status: "complete"` (or `"cancelled-by-user"`) in `runtime-discovery.json`. Recompute the top-level `summary` counts (`sessionsRun`, `anonymousRoutes`, `authenticatedRoutes`, `formsObserved`, `apiCallsObserved`, `consoleErrors`).
3. Confirm all three artifacts exist on disk; if any are missing, surface the diagnostic.
4. Optionally run the runtime-vs-static comparison from the procedure reference (Step 5) if `static-analysis.json` is already written. Phase 5 does a full reconciliation regardless, so skipping is safe.

If `status: "cancelled-by-user"`, continue Phase 5 with what was captured and note in `migration-gap-log.md` that role-gated behavior may be under-covered.

### Output

- `migration-artifacts/runtime-discovery.json`, `runtime-forms.json`, `runtime-discovery-summary.md`.
- Per-role route map, network/API inventory, form submission contracts ready for Phase 5 reconciliation.

---

## Phase 5: Build Migration Model and Verification Checklist

**Goal:** Combine both agents' artifacts into a canonical migration model that drives SPA re-authoring, and produce the falsifiable verification checklist Phase 8.4's validator agent will check against.

### Actions

#### 5.1 Read the Agent Artifacts

Read every artifact under `<TARGET_PROJECT_ROOT>/migration-artifacts/`:
- From Phase 3: `edm-source-inventory.json`, `static-analysis.json`, `forms-inventory.json`, `static-analysis-summary.md`.
- From Phase 4: `runtime-discovery.json`, `runtime-forms.json`, `runtime-discovery-summary.md`.

If any required artifact is missing, return to the relevant phase — do not infer missing structure here.

#### 5.2 Build the Canonical Model

Follow the schema in `${CLAUDE_PLUGIN_ROOT}/skills/migrate-edm-to-spa/references/edm-migration-model.md`.

Use `${CLAUDE_PLUGIN_ROOT}/skills/migrate-edm-to-spa/references/edm-to-spa-patterns.md` to classify Liquid (composition/static → component/content; safe read-only data → Web API; server-only context / privileged access / server-evaluated rules → **Server Logic** handed off to `/add-server-logic` in Phase 7.3; ambiguous → manual gap). Routes with explicit patterns in the reference (profile / sign-in / search / access-denied / entity CRUD / admin / Copilot embed) **must not** be defaulted to `manualGap` without applying them first.

When merging the two agents' form classifications, runtime wins on endpoint/method (network evidence is authoritative for the SPA's Web API call shape); static wins on field semantics, validation rules, and target table. Record disagreements in the form's `caveats[]`.

#### 5.3 Build the EDM-to-SPA Mapping Matrix

For each EDM capability, assign one migration status: `Direct SPA equivalent`, `Requires Web API`, `Requires server logic`, `Requires auth/role work`, `Requires custom code`, `Manual gap`.

#### 5.4 Gap Pre-Check (Required Before Any `manualGap` Is Emitted)

Before any entry lands in the canonical model with `targetKind: "manualGap"` or in `GAPS_DATA`, run this two-step check. Most agent classification errors come from lazy pattern-matching ("X looks complex → manual gap") without reading the underlying source. The pre-check catches that.

##### 5.4.a Refuse `manualGap` for mandatory-route-family items

If the underlying source artifact matches a row in `${CLAUDE_PLUGIN_ROOT}/skills/migrate-edm-to-spa/references/edm-to-spa-patterns.md#mandatory-route-families`, **`manualGap` is forbidden** for the route itself. The mandatory families are: not-found / 404, access-denied / 403, search, profile / user account, sign-in / sign-out / auth callback, registration / invitation / password reset, entity list / detail / create / edit, admin / role-gated, Copilot / bot embed.

For each, the patterns reference names the required SPA implementation (a real component plus services from `/integrate-webapi`, `/setup-auth`, `/create-webroles`, or `/add-server-logic`). Use that instead. Specific sub-features within the route (federated linking on profile, CAPTCHA on registration, faceted search on knowledge) may still be `manualGap` entries — but the route itself never is.

##### 5.4.b Read-before-classify rule for source-derivable configuration

A `manualGap` is only justified when the agent cannot safely or correctly produce the migrated artifact even with all the source files in hand. "Needs an env var sourced from the EDM YAML" is **not** a `manualGap` — it is configuration the implement skill wires up automatically.

Before writing any `manualGap` entry, open every source file the gap claims is unparseable. If the file is structured YAML/JSON and the missing piece is a single value (an ID, a URL, a name), the gap is invalid — instead, write a `componentMapping[]` entry whose `target` extracts the value from the source, and include the value in the canonical model's `envVars[]` (or equivalent) so Phase 7.3 wires it via `.env` or `.powerpages-site/*.sitesetting.yml`. Examples that are **never** `manualGap`:

| Gap-shaped pattern (looks like a gap, isn't) | What it actually is | Where the value comes from |
|-----------------------------------------------|---------------------|----------------------------|
| Copilot / bot embed needs a schema name | Component work | `botconsumer.yml#adx_botschemaname` → `.env` (`VITE_COPILOT_BOT_SCHEMA`) |
| Entra ID auth needs tenant + client IDs | `/setup-auth` work | `sitesetting.yml` (`Authentication/OpenIdConnect/*/Authority`, `ClientId`) → `.env` and `.powerpages-site/site-settings/Authentication-*.sitesetting.yml` |
| Site needs a logo / favicon | Asset reuse work | `web-files/<logo>*` → `public/<filename>` per `edm-to-spa-patterns.md#reuse-edm-source-assets` |
| Table needs Web API enabled | `/integrate-webapi` work | `sitesetting.yml` (`Webapi/<table>/enabled`, `/fields`) → `.powerpages-site/site-settings/Webapi-<table>-*.sitesetting.yml` |
| Web role exists in source | `/create-webroles` work | `webrole.yml` → `.powerpages-site/web-roles/<role>.webrole.yml` |

Reserve `manualGap` for things that genuinely cannot be expressed as configuration-plus-component, such as: portal-managed session/progress state, CAPTCHA providers that can't be re-implemented client-side, custom Liquid that reads undocumented portal runtime globals, knowledge-management facets that require a server-side index.

##### 5.4.c Self-audit pass

After building a draft canonical model and `GAPS_DATA`, walk the gap list once more and answer for each entry, in writing in the `rationale` (or a `gapRationale` field on the gap entry):

1. Which mandatory-route-family row, if any, does this entry's source artifact match? (If yes → not a `manualGap`; refer to 5.4.a.)
2. Is the missing piece a single value findable in a source YAML/JSON file? (If yes → not a `manualGap`; refer to 5.4.b.)
3. What is the specific portal-runtime feature that makes this genuinely impossible to reproduce in a static SPA?

A gap entry that cannot answer (3) with a specific feature name (not a category) is a candidate for re-classification.

#### 5.5 Score Confidence

`high` (static + runtime evidence, or deterministic config), `medium` (one evidence source or simple inference), `low` (ambiguous Liquid/JS or unavailable runtime paths). Low-confidence items become review items in Phase 6.

#### 5.6 Build the Verification Checklist

Walk the canonical model and the two agents' artifacts to produce `migration-artifacts/migration-verification-checklist.json` per the schema in `${CLAUDE_PLUGIN_ROOT}/skills/migrate-edm-to-spa/references/migration-verification-checklist.md`. One falsifiable check per migrated route, form, Web API integration, auth wiring step, role, table permission, server-logic operation, asset, and metadata group, plus drift checks derived from the static/runtime comparison.

Set every check's initial `status` to `"pending"`. Mandatory-route-family checks and forms on those routes must be `blocker`-severity. The checklist is locked at user approval (Phase 6.5); regenerate it if the user revises the plan.

#### 5.7 Save Model Artifacts

Save `canonical-site-model.json`, `edm-to-spa-mapping.md`, `migration-gap-log.md`, `migration-verification-checklist.json`.

### Output

- Canonical model ready for user review in Phase 6.
- Verification checklist ready for Phase 8.4's validator.

---

## Phase 6: Review Migration Plan

**Goal:** Capture the new SPA's design choices, present the migration plan in an interactive HTML document, and get explicit user approval before `migrate-edm-to-spa-implement` writes any SPA files.

### Actions

#### 6.1 Capture New SPA Design Direction

Mirror the design experience from `/create-site`. Ask just two high-level questions — do **not** ask for raw palette hex values, density, navigation pattern, or font names.

| Question | Header | Options |
|----------|--------|---------|
| What aesthetic direction do you want for the new SPA? | Aesthetic | Minimal & Clean (Recommended), Bold & Vibrant, Dark & Moody, Warm & Organic |
| What's the overall mood? | Mood | Professional & Trustworthy (Recommended), Creative & Playful, Technical & Precise, Elegant & Premium |

Then read `${CLAUDE_PLUGIN_ROOT}/skills/create-site/references/design-aesthetics.md` and use the Aesthetic × Mood Mapping to derive Typography (Google Fonts pairing — never default to Inter/Roboto/Open Sans/Arial), color palette (five named hex values with a short descriptive name; avoid the cliched purple-on-white AI palette), Motion direction, Layout density (from EDM info density), and Navigation pattern (from existing primary nav).

Persist as `DESIGN_DATA` with `aesthetic` and `mood` as separate fields so they pass to `/create-site` verbatim in the implement skill's Phase 7.1.

`DESIGN_DATA` shape and field list are in `${CLAUDE_PLUGIN_ROOT}/skills/migrate-edm-to-spa/references/edm-migration-plan-data-format.md`.

#### 6.1.b Capture Weblink Layout (Only When the Source Has Weblink Sets)

Power Pages classic EDM sites use **web link sets** (`weblink-sets/`) to model link groups — primary navigation, footer columns, sidebar "quick links" widgets, related-content menus. These don't translate cleanly to a single SPA component without knowing how the user wants them laid out (horizontal pill row vs. stacked vertical list), and the choice meaningfully affects component generation in Phase 7.6.

Detection:

1. Check whether `<EDM_SOURCE_ROOT>/weblink-sets/` exists. Use `Glob` for `<EDM_SOURCE_ROOT>/weblink-sets/**/*.weblinkset.yml` (and the `.weblinkset/` directory variant if the PAC export uses that shape).
2. Collect the set names (the file basename without the `.weblinkset.yml` extension is usually the human-readable name; cross-check by reading `adx_name` in each YAML if available).
3. If zero sets are found, skip this step — set `DESIGN_DATA.weblinkLayout` to `null` and continue to 6.2. Do not ask the user about a choice that does not apply.

When one or more sets exist, ask once:

| Header | Question | Options |
|--------|----------|---------|
| Weblink layout | The source has `<N>` web link set(s): `<comma-separated set names, truncate to 5 with "…">`. The migrated SPA will re-author these as link list components. How should they be laid out? | Horizontal — pills or inline row, Vertical — stacked list |

Store the answer as `DESIGN_DATA.weblinkLayout` (`"horizontal"` or `"vertical"`).

A single choice applies to every weblink set in the site. If the user wants different layouts per set (e.g., horizontal primary nav but vertical footer columns), they can adjust the plan during the Phase 6.5 revise loop — surface that option in the HTML plan's Design System block so it is visible during review.

The chosen layout flows through `DESIGN_DATA` to:

1. The HTML plan's Design System block (visible to the user during Phase 6 review).
2. `/create-site` in implement Phase 7.1 (so the scaffold's link-set component honors the choice).
3. Phase 7.6 component implementation (which builds one link-set component per source set, using the layout).

#### 6.2 Consolidate Plan Data

Build a JSON object from `canonical-site-model.json` + `DESIGN_DATA` per the schema in `${CLAUDE_PLUGIN_ROOT}/skills/migrate-edm-to-spa/references/edm-migration-plan-data-format.md`. Required keys: `SITE_NAME`, `PLAN_TITLE` (always `"EDM Migration Plan"`), `SUMMARY`, `SITE_STATS` (`componentCount` counts only `targetKind` `component`/`content` — never `serverLogic`/`webApi`/`manualGap`), `ROUTES_DATA`, `DATAVERSE_DATA`, `SECURITY_DATA`, `GAPS_DATA`, `RATIONALE_DATA`, `DESIGN_DATA`.

Every `ROUTES_DATA[]` entry **must** include a `rationale` string explaining why the chosen `componentMapping` is correct: cite the EDM evidence (specific source artifact, runtime observation, or Form Conversion Standard from `edm-to-spa-patterns.md`) and any caveats. The rendered Routes table surfaces this column so reviewers can challenge the mapping without re-reading the source. Generic phrases like "standard mapping" or "follows convention" are not acceptable — be specific.

Write to a temporary JSON file (e.g., `edm-migration-plan-data.json`).

#### 6.3 Render and Open HTML Plan

Write to `<PROJECT_ROOT>/docs/edm-migration-plan.html` (create `docs/` if needed). Do **not** hand-author the HTML:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/render-edm-migration-plan.js" --output "<OUTPUT_PATH>" --data "<DATA_JSON_PATH>"
```

The render script refuses to overwrite. If the default path exists, choose a new descriptive filename (e.g., `edm-migration-plan-revised.html`). After rendering, open the file in the user's default browser.

The rendered plan has tabs: **Overview** (aesthetic + mood + palette swatches), **Routes** (EDM artifacts → SPA replacement with `Server Logic` / `Web API` / `Manual Gap` badges), **Data Model** (lazy-rendered Mermaid ER diagram from `DATAVERSE_DATA[].fields` + `relationships`), **Gaps & Manual Work** (from `GAPS_DATA` plus high-risk findings).

#### 6.4 Present CLI Summary

Do **not** repeat the full plan in the CLI. Show a brief pointer:

```
✓ Migration plan rendered to: docs/edm-migration-plan.html
  Opening in your browser now...

Quick Summary:
  • Routes: <routeCount> SPA routes mapped from <N> EDM pages
  • Components: <componentCount> reusable SPA components
  • Tables: <tableCount> Dataverse tables with Web API integration
  • Server logic: <N> handed off to /add-server-logic in implement Phase 7.3
  • Gaps: <manualGapCount> unsupported features requiring manual work
  • Confidence: <N> high, <N> medium, <N> low
  • Design: <aesthetic> + <mood> — <palette name> palette, <layout>, <navigation> nav

Review the plan in the browser, including the Gaps & Manual Work tab, then confirm below.
```

#### 6.5 Confirm Plan Scope

| Question | Options |
|----------|---------|
| Approve this migration plan? | Approve and implement, Revise the plan, Narrow scope, Stop |

On **Revise the plan**: update the model + checklist, regenerate the HTML (use a new filename — the render script never overwrites), open the updated plan, ask again.

On **Stop**: clean up temp artifacts and exit.

On **Approve and implement**: continue to 6.6 — do **not** invoke the implement skill from here (the meta skill is responsible for that handoff).

#### 6.6 Write the Analyze-Complete Signal

Write `<TARGET_PROJECT_ROOT>/migration-artifacts/analyze-complete.json` so `migrate-edm-to-spa-implement` (and the meta skill) know analysis finished and was approved:

```json
{
  "status": "approved",
  "approvedAt": "<ISO 8601>",
  "edmSourceRoot": "<EDM_SOURCE_ROOT>",
  "targetFramework": "<TARGET_FRAMEWORK>",
  "targetProjectRoot": "<TARGET_PROJECT_ROOT>",
  "liveSiteUrl": "<LIVE_SITE_URL or null>",
  "planPath": "<absolute path to the HTML plan>"
}
```

Tell the user analysis is complete and they can invoke `migrate-edm-to-spa-implement` (or let the meta skill handle the handoff) to continue.

### Output

- `DESIGN_DATA` captured for `/create-site` reuse in the implement skill's Phase 7.1.
- Approved migration plan rendered to `docs/edm-migration-plan.html`.
- `migration-artifacts/analyze-complete.json` written as the explicit handoff signal.

---

## Key Decision Points

1. **Phase 1**: Source mode, target framework, output location, runtime URL availability.
2. **Phase 4**: Authenticated browsing or destructive form interactions.
3. **Phase 6**: Plan approval (HTML-driven; the single approval gate for the analyze skill).

---

## Progress Tracking

| Task subject | activeForm | Description |
|--------------|------------|-------------|
| Phase 0: Confirm dev environment | Phase 0: Confirming dev environment | Display the source-environment warning to the user and gate progress with `AskUserQuestion`; stop if not confirmed |
| Phase 1: Resolve migration source | Phase 1: Resolving source | Collect website record ID or downloaded path, target framework, output location, live URL |
| Phase 2: Assess migration readiness | Phase 2: Assessing readiness | Inventory PAC records, score complexity, flag unsupported/high-risk patterns |
| Phase 3: Analyze EDM source | Phase 3: Analyzing source | Delegate static analysis to `migration-static-analyzer` (parallel with Phase 4); inventory pages, templates, snippets, lists, forms, assets, custom code, auth, roles, permissions |
| Phase 4: Discover runtime behavior | Phase 4: Discovering runtime | Capture `INTERACTIONS_MODE`, derive role hint, drive the multi-session Playwright crawl in the main agent (parallel with Phase 3); ask the user to log in between sessions, verify via `browser_snapshot`, capture per-session routes, network calls, form submission contracts |
| Phase 5: Build migration model | Phase 5: Building model | Build canonical model, EDM-to-SPA matrix, confidence scoring, verification checklist |
| Phase 6: Review migration plan | Phase 6: Reviewing plan | Capture design direction, render HTML plan, get user approval, write `analyze-complete.json` |

---

## Test Prompts

| Scenario | Example |
|----------|---------|
| Fresh download | "Migrate the EDM portal with website ID `dfcd9f05-5305-458a-a82b-1ce97f05f535` to a React SPA — analysis only." |
| Existing source | "I already downloaded the portal to `./legacy-site`; do the analysis and produce a Vue migration plan." |
| Skip runtime | "Analyze `./legacy-site` for an Astro migration without runtime discovery." |
