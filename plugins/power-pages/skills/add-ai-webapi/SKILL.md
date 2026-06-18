---
name: add-ai-webapi
description: >-
  Integrates Power Pages generative-AI summarization APIs (PREVIEW) into a Single Page Application
  (SPA) site — the Search Summary API and the Data Summarization API — on any record-detail or list
  page. Generates per-target service code (CSRF-handled) and AI site settings; delegates Web API
  settings, table permissions, and web roles to `/integrate-webapi` and `/create-webroles`. Use
  whenever a user wants AI/Copilot output that condenses Dataverse content on a Power Pages site —
  an AI summary, AI-generated overview or "key insights" across a record or list, a search-results
  summary, a case/incident summary, or recommendation-chip refinement — even when phrased as
  "AI-generated paragraph", "insights", or "overview". Do NOT use for: generative pages in
  model-driven apps (use the model-apps `genpage` skill), Copilot Studio agents/chatbots,
  summarizing documents or PDFs, Power BI dashboards, plain keyword search with no AI summary, or
  plain Dataverse CRUD (use `/integrate-webapi`).
user-invocable: true
argument-hint: Optional description of which pages/tables need AI capabilities
allowed-tools: Read, Write, Edit, Bash, Grep, Glob, AskUserQuestion, Skill, Task, TaskCreate, TaskUpdate, TaskList, mcp__plugin_power-pages_microsoft-learn__microsoft_docs_search, mcp__plugin_power-pages_microsoft-learn__microsoft_docs_fetch
model: opus
---

> **Plugin check**: Run `node "${PLUGIN_ROOT}/scripts/check-version.js"` — if it outputs a message, show it to the user before proceeding.

# Add AI Web API

> **Note**
>
> AI summarization APIs are a preview feature. Preview features aren't meant for production use and may have restricted functionality. These features are available before an official release so that customers can get early access and provide feedback.

**Surface this note to the user verbatim** during Phase 1 and again in the Phase 8 summary —
copy the exact `**Note**` block above (including its wording about "available before an official
release so that customers can get early access and provide feedback"). Do not paraphrase it into
your own "Preview-feature note: ..." sentence; the wording matches the Microsoft Learn preview
disclaimer and rephrasing it loses that fidelity.

Integrate Power Pages generative-AI summarization APIs into a SPA site. This skill focuses on the AI layer (Layer 3): the summarization service code and the `Summarization/*` site settings. The underlying Web API prerequisites — `Webapi/<table>/enabled`, `Webapi/<table>/fields`, table permissions, and web roles — are **delegated** to `/integrate-webapi` and `/create-webroles` so there is a single source of truth for every layer.

## The two APIs covered

| # | API | URL | Body | Response |
|---|-----|-----|------|----------|
| 1 | **Search Summary** | `POST /_api/search/v1.0/summary` | `{ userQuery }` | `{ Summary, Citations }` |
| 2 | **Data Summarization** | `POST /_api/summarization/data/v1.0/<entitySet>(<id>)?$select=...&$expand=...` | `{ InstructionIdentifier }` or `{ RecommendationConfig }` | `{ Summary, Recommendations }` |

> **Example: Microsoft-shipped Copilot summary on a support-case page.** Data Summarization can be
> called with any combination of entity set, columns, and prompt — but Microsoft documents and
> ships one specific configuration for the standard `incident` table:
> `POST /_api/summarization/data/v1.0/incidents(<caseId>)?$select=description,title&$expand=incident_adx_portalcomments($select=description)`
> with body `{ "InstructionIdentifier": "Summarization/prompt/case_summary" }`. This is sometimes
> called the "Case-page Copilot preset" in Microsoft Learn. Treat it as one possible Data
> Summarization recipe — useful when the user explicitly wants to mirror the Microsoft sample —
> not as an automatic recommendation. A custom case-like table (`cr363_servicerequest`,
> `adx_case`), or the standard incident table summarised on different facets (priority, owner,
> SLA timer), is just a regular Data Summarization call with maker-defined values.

> Reference: `${PLUGIN_ROOT}/skills/add-ai-webapi/references/ai-api-reference.md` — canonical
> API shapes, required headers, site-setting names, error codes, and the documented support-case
> example. Read this at the start of the workflow; fetch the Microsoft Learn source pages with
> `mcp__plugin_power-pages_microsoft-learn__microsoft_docs_fetch` if the user asks for the latest.

> **Admin governance hierarchy**: both APIs are gated by a **three-level admin
> hierarchy** — tenant PowerShell setting (`enableGenerativeAIFeaturesForSiteUsers`), Copilot Hub
> environment/site governance, and the site-level maker toggle (for Search Summary: Set up
> workspace → Copilot → Site search (preview) → Enable Site search with generative AI (preview)).
> **Each level overrides the one below it**, so "the maker toggle is on but the API still says
> disabled" is a real scenario — admin-level governance wins.
>
> The two endpoints surface disablement differently:
>
> - **Search Summary** → HTTP **200** with an embedded envelope `{ Code: 400, Message: "Gen AI
>   Search is disabled." }`. The generated `fetchSearchSummary` detects this and throws
>   `SearchSummaryApiError`; the UI renders a remediation card.
> - **Data Summarization** → HTTP **400** with `error.code = 90041001` (admin-level disabled) or
>   `90041003` (per-site `Summarization/Data/Enable=false`).
>
> Full troubleshooting checklist (tenant → environment → site, plus runtime version, Bing
> dependency, and cross-region data movement) lives in
> `references/ai-api-reference.md` §1 "Troubleshooting: AI feature appears disabled (admin
> hierarchy)" — point users there when either disablement shape surfaces. Mention this governance
> hierarchy explicitly to the user before Phase 7, and again in the Phase 8 summary.

> **Built-in search control vs. custom code path**: if the site uses the Microsoft-shipped Power
> Pages search **control** and only wants AI-summarised search results on that page, they don't
> need this skill — just the Copilot workspace toggle and the `Search/Summary/Title` content
> snippet. This skill is for sites that build their own search UI or need to call
> `/_api/search/v1.0/summary` from custom code. Confirm which path the user is on in Phase 1.

## Core principles

- **Layer 3 only, delegate the rest.** Web API site settings, table permissions, and web roles all belong to `/integrate-webapi` and `/create-webroles`. This skill creates the summarization service code and the `Summarization/*` site settings — nothing else.
- **Sequential agent spawning.** Per `plugins/power-pages/AGENTS.md`, spawn the `ai-webapi-integration` agent sequentially per target (never in parallel). The first call establishes the shared summarization service file and CSRF helper; subsequent calls extend it. `ai-webapi-settings-architect` runs alone, after all code integrations land.
- **Raw `fetch` + CSRF.** Every summarization request attaches `__RequestVerificationToken` (from `/_layout/tokenhtml`) and `X-Requested-With: XMLHttpRequest`. Never route through an OData wrapper.
- **Skip `/integrate-webapi` when it's not needed.** If every confirmed target is Search Summary (which has no per-table Web API prerequisites), or every Layer 1/2 prerequisite already exists on disk, the skill goes straight from Phase 3 to Phase 5.
- **Use TaskCreate/TaskUpdate** — create the todo list upfront with all phases before starting.

> **Prerequisites:**
>
> - An existing Power Pages SPA site created via `/create-site`
> - A Dataverse data model (tables + columns) set up via `/setup-datamodel` or manually — for any
>   Data Summarization target
> - The site must have been deployed at least once (`.powerpages-site` folder must exist) for the
>   settings phase

**Initial request:** $ARGUMENTS

---

## Workflow

(Phase headings below the workflow keep the technical "Layer 1+2 / Layer 3" names because they
describe the runtime layering and are what maintainers grep for. The titles here mirror the
user-facing task list.)

1. **Check site is ready** — locate project, detect framework, check data model, deployment status, and web-role presence.
2. **Find where AI summaries fit** — scan code for search / data summarization candidates.
3. **Confirm what to add** — review the manifest and pick which APIs / targets to integrate.
4. **Set up data access for AI** — invoke `/create-webroles` if needed, then invoke `/integrate-webapi` in AI-only read mode for data/case targets. Skip entirely for search-only or when prerequisites already exist.
5. **Add AI summary code** — invoke the `ai-webapi-integration` agent sequentially per target.
6. **Register AI prompts** — invoke the `ai-webapi-settings-architect` agent.
7. **Verify everything** — header-contract grep, `$select` grep, `npm run build`, validator script.
8. **Review and deploy** — record skill usage, summarise, offer `/deploy-site`.

---

## Iteration mode (after first run)

This skill is a **one-shot setup skill** — Phases 1–8 run end-to-end the first time the user asks
to integrate a summarization API. Once an AI surface is in place (service file, framework wrapper,
UI call site, and `Summarization/*` settings all exist), follow-up requests to tweak the rendered
UI (colours, spacing, copy, moving a button, a different empty-state message, wiring a second
recommendation into the hook, etc.) are **not** a reason to re-enter this skill mentally and run
every phase again. Doing so triggers a full `pac pages upload-code-site` and a chain of
`git commit`s for each tweak, which is exactly the noisy cadence the Phase 5.5 / 6.4 prompts above
are there to avoid.

When the user asks for follow-up UI changes to an already-integrated AI surface:

- **Edit the file(s) and run `npm run build`** locally to verify the tweak compiles. That is the
  whole validation loop for a UI change.
- **Do NOT automatically run `pac pages upload-code-site`.** Uploading should happen once, at the
  end of the session, when the user has finished tweaking.
- **Do NOT automatically `git commit`.** Let the user batch related tweaks into a single commit.
- **Batch the deployment and commit into a single end-of-session prompt** once the user signals
  they're done (or when you've completed the last requested change).

<!-- gate: add-ai-webapi:iter.deploy-commit | category=consent | cancel-leaves=nothing -->

> 🚦 **Gate (consent · add-ai-webapi:iter.deploy-commit):** End-of-iteration batched deploy + commit prompt — avoids a noisy per-tweak upload/commit cadence.
>
> **Trigger:** User signals they're done with UI tweaks for the session.
> **Why we ask:** Auto-deploying or committing after every small edit produces one `git commit` + one `pac pages upload-code-site` per tweak; batching keeps history readable and avoids redundant deploys.
> **Cancel leaves:** Nothing — source files already edited; no deploy or commit fired.

  Use `AskUserQuestion`:

  | Question | Header | Options |
  |----------|--------|---------|
  | All the UI tweaks look good. Deploy the site and commit the changes now? | Deploy & commit | Yes, deploy and commit (Recommended), Just commit — I'll deploy later, Just deploy — I'll commit later, Neither — I'll handle both myself |

Re-enter the full skill flow only when the user is adding a **new** AI surface (a new page, a new
table, a second API). If you're unsure whether a request is a tweak or a new surface, ask.

---

## Phase 1: Verify Site Exists

**Goal**: Locate the Power Pages project root and confirm prerequisites.

### 1.0 Detect iteration mode (before anything else)

Re-entry detection comes first because the rest of the skill assumes a first-time setup.
Capture two signals about the project state:

1. **Service signal**: a summarization service exists — `src/services/aiSummaryService.*`, or any
   source file under `src/` that contains `/_api/search/v1.0/summary` or
   `/_api/summarization/data/v1.0/`. When the signal is present, also note which API surface(s)
   the service code references — search-only, data-only, or both. This sub-classification matters
   below.
2. **Settings signal**: at least one Layer 3 site setting exists in
   `.powerpages-site/site-settings/Summarization-*.sitesetting.yml`.

Then route on the combination:

- **Both signals present** → re-entry. A previous `/add-ai-webapi` run completed end-to-end. Show
  the iteration-mode prompt below.
- **Service signal present and the existing service code is search-only** (it references
  `/_api/search/v1.0/summary` but **not** `/_api/summarization/data/v1.0/`) → re-entry. Search-only
  sites legitimately have no `Summarization/*` settings (Search Summary uses the workspace toggle,
  not per-call settings), so the absence of the settings signal is the steady state, not a
  failed run. Show the iteration-mode prompt below.
- **Service signal present and the existing service code includes Data Summarization** but the
  settings signal is absent → in-flight first run (a previous attempt failed before Phase 6
  landed). Continue with the full flow without prompting.
- **Neither signal present** → first-time run. Continue with Phase 1.1.

When you reach the iteration-mode branch, ask:

| Question | Header | Options |
|----------|--------|---------|
| It looks like an AI summary surface is already wired into this site. Is this request a tweak to the existing one, or are you adding a brand-new surface (new page, new table, second API)? | Mode | Tweak the existing surface (Recommended for visual/copy edits), Add a new surface (run the full skill again), Not sure — show me what's already wired |

- **Tweak the existing surface**: stop running this skill. Switch into the workflow described in
  the [Iteration mode](#iteration-mode-after-first-run) section above — Edit + `npm run build`,
  no auto upload-code-site, no auto commit, batched end-of-session prompt for deploy + commit.
- **Add a new surface**: continue with Phase 1.1 (full flow). The downstream phases will detect
  existing infrastructure (CSRF helper, summarization service, settings) and extend rather than
  duplicate.
- **Not sure — show me what's already wired**: list the existing service file(s), wired UI
  components, and `Summarization/*` settings, then re-ask the same question.

### 1.1 Create todo list

Create all 8 phase tasks upfront via `TaskCreate` — see [Progress Tracking](#progress-tracking).

### 1.2 Locate project

Look for `powerpages.config.json` in the current directory or immediate subdirectories.

**If not found**: tell the user to create a site first with `/create-site`.

### 1.3 Detect framework

Read `package.json` and detect React / Vue / Angular / Astro. See
`${PLUGIN_ROOT}/references/framework-conventions.md`.

### 1.4 Check for data model

Look for `.datamodel-manifest.json`. If found, read it — tables listed here are candidates for the
Data Summarization API. The standard `incident` table is a candidate like any other; do not
treat it specially.

### 1.5 Check deployment status — hard prerequisite

Look for `.powerpages-site`. Phase 4 (`/integrate-webapi`) and Phase 6 (`ai-webapi-settings-architect`)
both require this folder to exist. Deferring the deploy until later is **not** a viable workaround:
once Phase 5 has written the AI-calling service code, deploying a site whose Layer 1/2/3 settings
aren't yet on disk publishes runtime-broken code (every summarization call 403/500s until a second
deploy lands). The cleanest sequence is to deploy the **clean scaffold** now, before any AI code
exists.

**If `.powerpages-site` does NOT exist:**

| Question | Header | Options |
|----------|--------|---------|
| `.powerpages-site` was not found. The AI summary skill needs the site deployed at least once before configuring permissions and settings. Deploy the clean scaffold now (no AI code yet — keeps the intermediate state safe), or stop and run `/deploy-site` yourself first? | Bootstrap deploy | Yes, deploy the scaffold now (Recommended), Stop — I'll deploy first then re-run /add-ai-webapi |

On **Yes**: invoke the `Skill` tool for `power-pages:deploy-site` and wait for completion. Then
re-check `.powerpages-site` exists before proceeding. **If it is still absent** after the
sub-skill returns (deploy failed mid-flow, the user cancelled it, or an upload completed but the
local folder wasn't created), stop here with a clear message — surface the deploy-site outcome
verbatim so the user can debug it, and tell them to re-run `/deploy-site` followed by
`/add-ai-webapi`. Do NOT silently fall through to Phase 2; the downstream sub-skills require this
folder.

On **Stop**: end the skill with a clear next-step message ("Run `/deploy-site`, then re-invoke
`/add-ai-webapi` to continue"). Do NOT continue to Phase 2 — the downstream sub-skills can't run.

### 1.6 Check web roles

Look for `.powerpages-site/web-roles/*.yml`. Record whether any roles exist — the Phase 4
delegation needs at least one role before `/integrate-webapi` can create table permissions.

**Output**: confirmed project root, framework, data-model availability, deployment status, web-role inventory.

---

## Phase 2: Explore AI integration points

**Goal**: Find every candidate for each of the two APIs — scoped to AI only.

The full Explore-agent prompt body, manifest shape, and delegation-decision rules live in
`${PLUGIN_ROOT}/skills/add-ai-webapi/references/explore-prompt.md`. Read that file
first, then invoke the **Explore agent** (via `Task` with `subagent_type: "Explore"`,
thoroughness `medium`) and pass the prompt body verbatim.

What the Explore agent reports back (summary — see the reference for the exact prompt):

- **Reserved-slot markers** (`POWERPAGES:AI-SLOT kind=<pick>`) — authoritative placement hints
  planted by `/create-site`; orphan markers are flagged for Phase 3 to resolve.
- **Search Summary candidates** including related-record-discovery targets on detail pages
  ("suggested KB articles", "similar cases").
- **Data Summarization candidates** classified `single-record` / `list` / `intent-mismatch`,
  each with the existing fetch's OData query and a scope classification
  (`matches-existing-fetch` / `scope-extends-beyond-existing-fetch` / `needs-definition` /
  `intent-mismatch`).
- **Existing infrastructure** — CSRF helper, `powerPagesApi.ts`, prior `aiSummaryService.*`.
- **Layer 1/2 status** per Data Summarization target plus every `$expand` target —
  `ready` / `missing` / `n/a (search)`.
- **Fields-list breadth advisory** — for Layer 1/2 `ready` rows whose existing
  `Webapi/<table>/fields` is broader than the AI surface needs (primary key included, lookup
  write forms, unused columns), flagged `fields-broader-than-ai-mode` so Phase 3 can surface
  it.
- **Layer 3 status** per Data Summarization target — `Summarization/Data/Enable` and the
  specific `Summarization/prompt/<id>` the code will send.

Compile the integration manifest from the agent's output (one row per candidate, columns:
`#`, `API`, `Target file`, `Target kind`, `Entity Set`, `$select` / `$expand`, `Source`,
`Layer 1/2 status`, `Layer 3 status`) — the reference file contains a worked example.

**Delegation decisions** (compute directly from the status columns):

- Run `/integrate-webapi`? → True if any row's Layer 1/2 status is `missing`. Send only the
  missing-status rows in the `tables=` sentinel; don't re-audit settled tables.
- Run `ai-webapi-settings-architect`? → True if any row's Layer 3 status is `missing`.

**Output**: integration manifest + delegation decisions + existing-infra report +
fields-broader-than-ai-mode advisory list (if any).

---

## Phase 3: Review AI plan

**Goal**: Present the manifest and confirm which APIs / targets to integrate.

Show the user:

1. The list of APIs and targets found.
2. For each: which file references it and what the service will do.
3. The two delegation decisions from Phase 2 ("Will invoke `/integrate-webapi` for [tables]",
   "Will invoke `ai-webapi-settings-architect` for Layer 3").
4. Existing-infrastructure notes (CSRF helper reuse, `powerPagesApi.ts`, previous
   `aiSummaryService.*`).

### Approval cadence (set expectations up-front)

Before asking the integration question, briefly tell the user how many more decision points
are coming so the "one-shot" run isn't surprising. Count them from the
[Key decision points](#key-decision-points-wait-for-user) list, subtracting the ones that
don't apply for this run:

- **Search-only run**: drop the `/integrate-webapi` delegation (Phase 4) and the settings
  architect (Phase 6) — 4–5 more pauses after this one.
- **Layer 1/2 already ready**: drop the Phase 4.3 architect approvals.
- **No list / scope-extends / intent-mismatch rows**: drop the per-target Phase 3 follow-ups.
- **First-time run with all branches firing**: 7–10 more pauses (web-role choice, per-target
  list-trigger and scope-confirmation, two integrate-webapi architect plans, the AI
  settings architect plan, two commit prompts, final deploy).

Phrase it as a heads-up, not a warning — e.g., "I'll pause for your input ~6 more times
after this one (web-role choice, two architect plans, two commit prompts, final deploy).
Could be a couple more if any list target needs a trigger or scope decision."

### The integration question

Use `AskUserQuestion` and **build the option list dynamically** from the Phase 2 manifest — do
not hardcode "Search summary and Data summarization" when only one category has candidates.
Construct the question text from what was found:

- If both categories have candidates: "I found candidates for Search Summary and Data
  Summarization. Which should I integrate?"
- If only one category with one target: skip "All of them" — just confirm the single target
  ("Wire Search Summary into `<page>`?").

The default option list, with rows present only when the corresponding category has candidates:

| Option | When to include |
|--------|-----------------|
| All of them (Recommended) | Both categories present |
| Only Search Summary | Search candidates present AND Data Summarization candidates present |
| Only Data Summarization | Data Summarization candidates present AND Search candidates present |
| Let me select specific ones | Always (multi-target runs) |
| None — cancel | Always |

If the user chooses "Let me select specific ones", follow up with a multi-select question listing
each row of the integration manifest. When a detail-page candidate was flagged in Phase 2 as a
related-record-discovery target, include it as a dedicated option (in addition to any Data
Summarization option for the same page) so the user can consciously pick the AI-grounded path
rather than a hand-rolled OData match — e.g.:

- `Search Summary on CaseDetail.tsx (finds related KB articles via generative AI)`
- `Search Summary on ProductDetail.tsx (finds related products via generative AI)`

Label the option with the page name and the outcome it produces, not just "Search Summary", so the
user sees exactly where the AI surface will appear.

### Per-target follow-up questions

After the user confirms targets, ask per-target follow-up questions only when needed:

- **List-trigger** — every list target gets a "load on open" vs "manual button" question.
- **Scope confirmation** — only when Phase 2 flagged the row `scope-extends-beyond-existing-fetch`,
  `needs-definition`, or `intent-mismatch`. Resolve `intent-mismatch` first because the
  chosen target kind decides which scope question (LIST or SINGLE-RECORD) to ask next.

Question text, option lists, and the scope-classification → question mapping live in
`${PLUGIN_ROOT}/skills/add-ai-webapi/references/scope-classification.md`. Read it
when any per-target follow-up is required.

The chosen values flow into the Phase 5 agent-invocation prompt as the **Scope for the summary
call** block (`$filter`, `$orderby`, `Scope source`, `Target's existing list fetch`). The
existing UI fetch on the target component stays in place unchanged — the summary URL is an
addition, never a replacement.

If the user picks a scope that adds new `$expand` targets (e.g., "include its line items"),
re-evaluate the Phase 2 Layer 1/2 delegation decision — the new expansion is a new
prerequisite (Web API enabled + parent-scope permission on the child table).

### Handling "None — cancel"

When the user picks `None — cancel`:

1. Mark the remaining tasks as `completed` with a `(skipped — cancelled by user)` suffix in the
   activeForm so the task list reads cleanly rather than leaving them stuck `pending`.
2. Jump straight to **Phase 8.1** (record skill usage with `--skillName "AddAiWebapi"` and an
   outcome of `cancelled`) and **Phase 8.2** (present a one-line summary: "No changes made — you
   cancelled at the plan-review step").
3. Skip Phases 4, 5, 6, 7, and 8.3 entirely. Do **not** invoke `/integrate-webapi`,
   `ai-webapi-integration`, `ai-webapi-settings-architect`, or `/deploy-site`. Do **not** commit.

**Output**: user-confirmed integration manifest, or a clean cancellation.

---

## Phase 4: Delegate Layer 1 + Layer 2

**Goal**: Ensure every Web API prerequisite for the AI target tables exists, by delegating to
`/create-webroles` and `/integrate-webapi` (AI-only read mode) instead of writing Layer 1/2 files
directly.

### 4.1 Skip-check

Skip this entire phase when **any** of the following is true:

- Every confirmed target is Search Summary (search has no per-table Web API prerequisites).
- The Phase 2 delegation decision said "Run `/integrate-webapi`? No" — all Layer 1/2 prerequisites
  are already on disk from prior runs.
- `.powerpages-site` does not exist (the sub-skills both require it).

In the skip case, proceed to Phase 5 and note this in the final summary.

### 4.2 Create missing web roles (if needed)

From Phase 1.6: if no web roles exist in `.powerpages-site/web-roles/`, or the roles that exist
don't match the site's auth model, ask the user:

| Question | Header | Options |
|----------|--------|---------|
| `/integrate-webapi` needs at least one web role to attach table permissions to. No matching role was found. Create one now via `/create-webroles`? | Web role | Yes, create via /create-webroles (Recommended), Skip — I'll handle roles separately |

On **Yes**: invoke the `Skill` tool for `power-pages:create-webroles` with a prompt that
includes the caller-suppress sentinel so the sub-skill does not issue its own deploy
prompts (the orchestrator owns the single end-of-run deploy decision):

> `[CALLED-BY-PARENT-SKILL] caller=add-ai-webapi`
>
> Create web roles for this Power Pages SPA site. The parent skill `/add-ai-webapi` will
> later attach AI-only read-mode table permissions to the role(s) you create. Do not issue
> deploy-now prompts — the orchestrator batches the deploy at the end.

Wait for it to complete. Then re-check `.powerpages-site/web-roles/` before proceeding to 4.3.

On **Skip**: this puts the run on a known-broken path — the AI endpoints will return 403 at
runtime until the user manually creates a web role + table permissions. Don't fall through
silently.

<!-- gate: add-ai-webapi:4.2.skip-webrole | category=consent | cancel-leaves=nothing -->

> 🚦 **Gate (consent · add-ai-webapi:4.2.skip-webrole):** Explicit acknowledgement before continuing without a web role — skipping leaves Layer 1/2 broken at runtime.
>
> **Trigger:** User chose "Skip" on the web-role creation offer.
> **Why we ask:** Proceeding silently means the AI API endpoints return 403 at runtime; surfacing the trade-off lets the user make an informed stop-vs-continue choice.
> **Cancel leaves:** Nothing — no code written yet.

Confirm the trade-off with a second `AskUserQuestion`:

| Question | Header | Options |
|----------|--------|---------|
| Without a web role I can't set up table permissions, so the AI endpoints will return 403 at runtime until you configure them yourself. Stop here so you can run `/create-webroles` first, or continue to write the frontend code anyway and let me flag the gap in the final summary? | Continue? | Stop here (Recommended), Continue — write frontend code only and flag the gap in the summary |

On **Stop here**: end the skill cleanly. Tell the user to run `/create-webroles` (and optionally
`/integrate-webapi`) first, then re-invoke `/add-ai-webapi`.

On **Continue**: skip the rest of Phase 4 (the `/integrate-webapi` delegation needs a web role to
attach permissions to, so running 4.3 would fail) and jump to Phase 5. In the Phase 8 summary,
flag the Layer 1/2 gap loudly — list the exact files the user still needs to create
(`Webapi/<table>/enabled`, `Webapi/<table>/fields`, table permissions per target) so the path to
a working runtime is obvious from the final message.

### 4.3 Invoke `/integrate-webapi` in AI-only read mode

Build the sentinel arguments from the Phase 2 manifest:

- `primary=<primary table logical name>` (the table whose record / collection is being summarised — e.g., `incident`, `cr4fc_product`, `cr363_workorder`)
- `tables=<primary plus every $expand target, comma-separated>`
- `expand-targets=<every $expand target, comma-separated; empty for pure data-summary targets with no $expand>`
- `caller=add-ai-webapi`

Invoke the `Skill` tool for `power-pages:integrate-webapi` with a single prompt:

> `[AI-READ-ONLY] mode=ai-read-only primary=<primary> tables=<list> expand-targets=<list> caller=add-ai-webapi`
>
> Configure Layer 1/2 (Web API site settings + table permissions) for the following Power Pages
> AI summarization targets: <table list>. This is a read-only integration — the `/_api/summarization/data/v1.0/`
> endpoint never mutates Dataverse. Return when all Web API site settings, table permissions, and the
> shared `powerPagesApi.ts` client are written to disk.
>
> **Per the AI-only read-mode contract** (your SKILL.md Phase 1.6):
> - **Do not commit.** Skip Phase 4.4 and Phase 6.5 — print the file list you would have
>   committed so this orchestrator can stage it later. The parent skill batches commits.
> - **Do not deploy.** Skip Phase 6.1 deploy ask, Phase 7.3 deploy ask, and Phase 7.4
>   post-deploy notes. Return the Phase 7.2 summary and stop. The parent skill owns the
>   single end-of-orchestration deploy.

`/integrate-webapi` detects the `[AI-READ-ONLY]` sentinel (its Phase 1.6) and runs its full flow
with hardened prompts: read-only table permissions, minimal fields list (no PK, only `_<col>_value`
for lookups), and a read-only service layer. It still presents plan-mode approval prompts to the
user for each architect — this skill does not suppress those.

Wait for `/integrate-webapi` to complete. Re-check the file system:

- `src/shared/powerPagesApi.ts` exists
- For every target table: `Webapi/<table>/enabled` exists, `Webapi/<table>/fields` exists
- For every target table: at least one table permission with `read: true` exists; Parent-scope
  permission present for every `$expand` target

If any prerequisite is still missing, surface this to the user before moving on — something in the
delegated flow didn't land (for example, the user declined the architect's plan). Do NOT silently
fall back to writing Layer 1/2 files here.

**Output**: Layer 1/2 prerequisites are on disk; shared `powerPagesApi.ts` + read-only service
exists; web roles exist.

---

## Phase 5: Implement Layer 3 code

**Goal**: Create the AI summarization service and wire it into each target's UI.

### 5.1 Invoke the `ai-webapi-integration` agent — first target (sequential)

For the first target in the confirmed manifest, invoke the agent at
`${PLUGIN_ROOT}/agents/ai-webapi-integration.md` via `Task`. The full prompt
template — every field the agent expects, with notes on which orchestrator phase resolved
each value — lives in
`${PLUGIN_ROOT}/skills/add-ai-webapi/references/agent-invocation-prompt.md`. Read
that file, copy the template, replace every `<…>` placeholder with the concrete value for
the current target, and pass it via `Task`. The agent does not interpret placeholders;
sending the literal text `<search | data>` will confuse it.

The first call is sequential because it establishes the shared summarization service file
(`src/services/aiSummaryService.*`) and the CSRF helper that subsequent targets reuse. The
agent returns a structured file-modification list (see its "Return value" section); record
it for Phase 5.5's per-file commit.

### 5.2 Verify service + CSRF helper exist

Before spawning more agents, verify:

- The summarization service file exists (default `src/services/aiSummaryService.ts`).
- `getCsrfToken` is defined once in the codebase (or imported from a pre-existing helper).

### 5.3 Invoke the agent for remaining targets — sequentially

Per `plugins/power-pages/AGENTS.md`, agent spawning is **sequential**. Invoke
`ai-webapi-integration` once per remaining target, waiting for each completion before starting the
next. Each target only adds an independent exported function, a framework wrapper (if not already
present), and wires one UI file — there are no merge conflicts, but the sequential rule keeps
failure modes simple.

If there is only one target total, skip 5.3.

### 5.4 Replace placeholder POSTs

For any placeholder `InstructionIdentifier` body the Explore agent flagged in Phase 2, the
sub-agent will have replaced them. Confirm by grepping for `InstructionIdentifier` in the affected
files and verifying each resolved call uses the real entity set and id.

### 5.5 Offer to commit

Don't commit automatically — on iterative runs an unprompted `git commit` here creates a noisy
series of commits for what is effectively one set of changes.

<!-- gate: add-ai-webapi:5.5.commit | category=consent | cancel-leaves=nothing -->

> 🚦 **Gate (consent · add-ai-webapi:5.5.commit):** Explicit commit decision after Phase 5 summarization-service + UI wiring is complete.
>
> **Trigger:** All Phase 5 targets have been wired (service, framework wrapper, UI call sites).
> **Why we ask:** Auto-committing on every integration run creates noisy one-commit-per-tweak history; letting the user batch is safer.
> **Cancel leaves:** Nothing — source files written; no `git commit` fired.

Use `AskUserQuestion`:

| Question | Header | Options |
|----------|--------|---------|
| Commit these Layer 3 integration changes now? | Commit | Yes, commit now (Recommended), Skip — I'll commit later |

On **Yes**: stage **only the files modified during Phase 5** — the summarization service,
framework wrapper(s), each wired UI page, and any safe-markdown renderer component the agent
emitted. The orchestrator already has this list from each `ai-webapi-integration` invocation's
file-modification report. Use explicit `git add <path>` per file; do **not** use `git add -A` —
unrelated work-in-progress files in `src/` could otherwise be swept into the commit. Substitute
`<targets>` in the commit message with a short human-readable list (e.g., `CaseDetail and SearchResults`,
or `3 pages` when there are many):

```powershell
git add <each file modified by the Phase 5 agents>
git commit -m "Add AI summarization integration for <targets>"
```

On **Skip**: proceed without committing. The user will batch the commit themselves at the end.

**Output**: summarization service + framework wrappers + UI call sites created for every confirmed
target.

---

## Phase 6: Configure Layer 3 settings

**Goal**: Register the `Summarization/*` site settings via the `ai-webapi-settings-architect` agent.

### 6.1 Skip-check

Skip this phase when both of the following are true:

- Every confirmed target is Search Summary (search has no per-call `Summarization/*` site settings;
  see [ai-api-reference.md](references/ai-api-reference.md#1-search-summary-api)).
- No Data Summarization target was added in Phase 3.

For search-only, remind the user to enable **Site search with generative AI (preview)** in the
site's Copilot workspace after deploy, and proceed to Phase 7.

### 6.2 Confirm deployment prerequisite still holds

Phase 1.5 already gated on `.powerpages-site` existing. Re-check it here as a guard — if it has
disappeared between Phase 1 and now (rare, but possible if the user manually cleaned the folder),
stop and re-run the Phase 1.5 bootstrap-deploy prompt. Do NOT silently fall through into the
architect with a missing folder.

### 6.3 Invoke `ai-webapi-settings-architect`

Invoke the agent at `${PLUGIN_ROOT}/agents/ai-webapi-settings-architect.md` via `Task`:

> "Analyse this Power Pages SPA site and propose generative-AI summarization site settings.
> The following Data Summarization targets were integrated in Phase 5: [list each target with its
> entity set, per-target `InstructionIdentifier` value, and **target kind** (`single-record` or
> `list`) — the architect needs this to decide on `Summarization/Data/ContentSizeLimit`].
> **If any target is `list`, the plan MUST include `Summarization/Data/ContentSizeLimit=200000`** —
> the 100k server default silently truncates list content; this is non-negotiable.
> Check for existing `Summarization/*` settings. Layer 1
> (`Webapi/<table>/*`) and Layer 2 (table permissions) were configured in Phase 4 via
> `/integrate-webapi` in AI-only read mode — verify they are present on disk and cite them as
> met in your plan's prerequisite table. Propose the AI plan via plan mode, and on approval
> create the YAMLs with `create-site-setting.js`."

Wait for the agent to complete. If it reports missing Layer 1/2 prerequisites, something in
Phase 4 didn't land — read the file system, identify the gap, and surface it to the user rather
than attempting to create Layer 1/2 files here.

### 6.4 Offer to commit

<!-- gate: add-ai-webapi:6.4.commit | category=consent | cancel-leaves=nothing -->

> 🚦 **Gate (consent · add-ai-webapi:6.4.commit):** Explicit commit decision after `Summarization/*` site settings are created by the architect.
>
> **Trigger:** `ai-webapi-settings-architect` has written all `Summarization/Data/Enable` + `Summarization/prompt/<id>` YAMLs.
> **Why we ask:** Auto-committing could bundle dirty pre-existing YAMLs into the commit; explicit consent scopes the commit to just the architect's output.
> **Cancel leaves:** Nothing — YAML files written to disk; no `git commit` fired.

Use `AskUserQuestion`:

| Question | Header | Options |
|----------|--------|---------|
| Commit the new `Summarization/*` site settings? | Commit | Yes, commit now (Recommended), Skip — I'll commit later |

On **Yes**: stage **only the files the architect just created** — use the
`filePath` list returned by `ai-webapi-settings-architect` (or the per-file paths printed by
each `create-site-setting.js` invocation), not a glob. A glob can sweep in pre-existing
`Summarization-*` YAMLs that are dirty for unrelated reasons (e.g., a prior partial run, or
a maker-edited prompt) and bundle them into the commit by accident.

Use explicit `git add <path>` per file:

```bash
git add <each Summarization-*.sitesetting.yml the architect just wrote>
git commit -m "Add AI summarization site settings"
```

On **Skip**: proceed without committing.

**Output**: `Summarization/Data/Enable`, `Summarization/prompt/<id>` settings created.

---

## Phase 7: Verify

**Goal**: Confirm every expected file exists, all POSTs set both required headers, and the project
builds.

> **Preview-feature reminder.** A green build doesn't mean the API will return a summary at
> runtime — admin-level governance (tenant PowerShell, Copilot Hub) or the site-level maker
> toggle for Search Summary can still block it. See the Preview-feature note at the top of
> this skill and the admin-hierarchy checklist in
> `references/ai-api-reference.md` §1 "Troubleshooting: AI feature appears disabled". Tell
> the user now so the post-deploy test isn't a surprise.

### 7.1 File inventory

For each confirmed target, confirm:

- **Service file**: `src/services/aiSummaryService.ts` (or project-convention equivalent) contains
  the expected exported function (`fetchSearchSummary` or `fetchDataSummary`; the agent may also
  emit a thin wrapper such as `fetchCaseSummary` when the user picked the support-case scenario).
- **Framework wrapper** (non-Astro): React hook in `src/hooks/`, Vue composable in
  `src/composables/`, or Angular service in `src/app/services/`.
- **UI wiring**: at least one page/component imports the service or wrapper and calls it.
- **Shared API client** `src/shared/powerPagesApi.ts` exists when any Data Summarization target was in scope.
- **`Summarization/Data/ContentSizeLimit` site setting** when any list-summary target was
  integrated. Grep the source for `fetchListSummary` — if any match exists, confirm
  `.powerpages-site/site-settings/Summarization-Data-ContentSizeLimit.sitesetting.yml` is
  present with `value: 200000` (or higher). Missing this setting silently caps list summaries at
  the 100k server default and ships the user truncated input. If it's missing, surface the gap
  to the user before completing Phase 7 — re-run the architect or create the YAML manually.

### 7.2 Header contract grep

```
Grep: "_api/search/v1\\.0/summary|_api/summarization/data/v1\\.0/" in src/**/*.{ts,tsx,js,jsx,vue,astro}
```

For every file that matches, verify the surrounding fetch includes:

- `__RequestVerificationToken` (CSRF token, fetched from `/_layout/tokenhtml`) — **hard rule**
- `X-Requested-With: XMLHttpRequest` — **recommended** (the validator warns when it's missing but
  does not block; it matches `shell.ajaxSafePost` and every other Power Pages POST)

For data summarization calls, additionally verify (both **hard rules**):

- The URL contains `$select=` (no wildcards)
- `OData-MaxVersion: 4.0` and `OData-Version: 4.0` headers are set

Fix any missing **hard-rule** header before proceeding. Missing CSRF produces 500s; missing
`$select` or OData headers produces 403/400s. A missing `X-Requested-With` only produces a
validator warning — add it for consistency, but it does not break the run.

### 7.3 Build check

```powershell
cd "<PROJECT_ROOT>"
npm run build
```

Fix any type or import errors. Common issues: missing import of the summarization service in a
wired page; type mismatch between `DataSummaryResponse` and the UI consumer; duplicate
`getCsrfToken` declarations (if Phase 5 failed to reuse the existing helper).

### 7.4 Present verification results

| Target file | API | Service fn | Wrapper | UI call site | Headers ✓ | `$select` ✓ |
|-------------|-----|-----------|---------|--------------|-----------|-------------|
| `src/pages/SearchResults.tsx` | Search summary | `fetchSearchSummary` | `useSearchSummary` | Yes | Yes | n/a |
| `src/pages/CaseDetail.tsx` | Data summarization | `fetchDataSummary` (optionally wrapped as `fetchCaseSummary`) | `useCaseSummary` | Yes | Yes | Yes |
| `src/pages/ProductDetail.tsx` | Data summarization | `fetchDataSummary` | `useProductSummary` | Yes | Yes | Yes |

(Same row order and example file paths as the Phase 2 manifest example, so a maintainer reading
both tables can trace each row top-to-bottom. Row 2 mirrors the Microsoft-shipped support-case
recipe — a Data Summarization call configured for `incidents` with the `case_summary` prompt
identifier.)

**Build status:** Pass / Fail (with details).

**Output**: all integration files verified; project builds.

---

## Phase 8: Review & Deploy

**Goal**: Record skill usage, present a summary, and offer deployment.

### 8.1 Record skill usage

> Reference: `${PLUGIN_ROOT}/references/skill-tracking-reference.md`

Use `--skillName "AddAiWebapi"`.

### 8.2 Present summary

| Step | Status | Details |
|------|--------|---------|
| Web roles | Created via /create-webroles / Reused existing / Skipped | role name(s) |
| Layer 1/2 (Web API settings + permissions) | Created via /integrate-webapi / Reused existing / Skipped (search-only) | list of files written |
| Summarization service | Created / Extended | exported functions, file path |
| Framework wrappers | Created / Extended | hook/composable/service paths |
| UI call sites | Wired | list of files |
| Layer 3 (Summarization/* settings) | Created / Already existed / Skipped | `Summarization/Data/Enable`, one per prompt |

### 8.3 Ask to deploy

| Question | Header | Options |
|----------|--------|---------|
| Everything is ready. Deploy the site so the summarization APIs become live? | Deploy | Yes, deploy now (Recommended), No, I'll deploy later |

**Yes**: invoke `/deploy-site`.
**No**: acknowledge. Remind that the API calls will not work until the site is deployed with the
new settings and permissions.

### 8.4 Post-deploy notes

Surface these to the user at the end of the run:

- **Search Summary toggle** — for any Search Summary integration, remind the user to flip
  **Set up workspace → Copilot → Site search (preview) → "Enable Site search with generative
  AI (preview)"**. Without it, the endpoint returns the disabled envelope and the UI renders
  the remediation card instead of a summary.
- **Test recipe** — for Data Summarization, open a record-detail or list page, trigger the
  summary, confirm 200 + rendered text, then click a recommendation chip and confirm the
  follow-up sends `RecommendationConfig`. For Search Summary, perform a search and confirm
  the summary renders above keyword hits with citation anchors pointing at the SPA route
  (not `/page-not-found/`). The `90041005` "nothing to summarize" branch is normal for the
  Microsoft-shipped support-case recipe on a freshly-created case with no comments — test
  with a record that has substantive content in every selected / expanded column.
- **When the disabled-state card or `90041001` shows up** — walk the admin-hierarchy
  checklist in `references/ai-api-reference.md` §1 "Troubleshooting: AI feature appears
  disabled (admin hierarchy)". Retry doesn't help; an admin or maker has to change
  governance / flip the site toggle.
- **403 on any summarization call is always a Layer 1/2 issue** (column casing in
  `Webapi/<table>/fields`, or missing `read: true` table permission) — re-run
  `/integrate-webapi` in AI-only read mode rather than hand-editing YAML.
- **Full error-code reference** (`90041001` … `90041006`) is in
  `references/ai-api-reference.md` §2 "Error codes". Open it when the user reports a 400.
- **Column permission profiles can silently hide content.** If a summary has obvious
  omissions, check Dataverse column permission profiles on the web role before suspecting
  the prompt or fields list.

**Output**: summary presented, deployment completed or deferred, post-deploy guidance given.

---

## Important Notes

### Throughout all phases

- **Use TaskCreate/TaskUpdate** to track progress at every phase.
- **Ask for user confirmation** at key decision points (list below).
- **Sequential agent spawning** — per the "Agent spawning" rule in `plugins/power-pages/AGENTS.md`. Never spawn `ai-webapi-integration` in parallel across targets (every target extends the same `aiSummaryService.*` file, so parallel runs would conflict).
- **Commit at milestones** — after implementation (Phase 5) and after settings creation (Phase 6).
- **Never use an OData wrapper for summarization fetches** — raw `fetch` only.
- **Never write Layer 1/2 files directly** — always delegate to `/integrate-webapi` / `/create-webroles`. This skill is Layer 3.

### Key decision points (wait for user)

The list below is the conservative upper bound — many runs hit fewer prompts because skip
checks (search-only run, Layer 1/2 ready, no list/intent-mismatch targets) eliminate whole
branches. Realistic worst case for a multi-target first-time run is ~10 prompts; a clean
re-entry tweak is just 1 prompt (the Phase 1.0 mode question).

1. **At Phase 1.0 (re-entry detection)**: tweak existing surface, add a new surface, or
   review what's already wired. Only fires when a previous `/add-ai-webapi` run left a
   service file or `Summarization/*` settings on disk.
2. **At Phase 1.5**: bootstrap deploy or stop (if `.powerpages-site` is missing).
3. **After Phase 3 (main)**: confirm which APIs / targets to integrate.
4. **Phase 3 per-target follow-ups (variable count)**: list-trigger choice (one per list
   target), and scope-confirmation (one per `scope-extends-beyond-existing-fetch`,
   `needs-definition`, or `intent-mismatch` row). Question text and option lists live in
   `references/scope-classification.md`.
5. **At Phase 4.2**: create missing web role via `/create-webroles` (if needed). The
   sub-skill is invoked with the caller-suppress sentinel — its own deploy prompts don't
   fire.
6. **At Phase 4.2 (Skip path only)**: confirm continuing despite known broken-runtime risk.
7. **Inside the Phase 4.3 `/integrate-webapi` delegation**: approve its
   `table-permissions-architect` plan and its `webapi-settings-architect` plan (each
   architect owns its own plan-mode prompt; the sub-skill is in AI-only read mode so its
   commit and deploy prompts are suppressed).
8. **At Phase 5.5**: commit the integration changes now or later.
9. **Inside the Phase 6.3 `ai-webapi-settings-architect` call**: approve its plan.
10. **At Phase 6.4**: commit the new settings now or later.
11. **At Phase 8.3**: deploy now or later.

### List-summary use case playbook

When the target is a LIST of records (not a single record), the defaults for a single-record
Copilot card are the wrong defaults — collection endpoint, tabular-insight prompt,
`ContentSizeLimit=200000`, `normalizeSummaryString` + safe-markdown renderer, etc.

The full 10-rule playbook (collection endpoint, scope mirroring, prompt size, nav-property
casing, mandatory `ContentSizeLimit`) lives in
`${PLUGIN_ROOT}/skills/add-ai-webapi/references/ai-api-reference.md` §2 "List-summary
playbook". Read that section before any list-summary target reaches Phase 5 — the Phase 5
agent and the Phase 6 settings architect both reference the same playbook.

### Progress tracking

Before starting Phase 1, create a task list with all phases using `TaskCreate`:

| Task subject | activeForm | Description |
|-------------|------------|-------------|
| Check site is ready | Checking site prerequisites | Locate project root, detect framework, check data model, deployment status, web-role inventory |
| Find where AI summaries fit | Scanning code for AI summary opportunities | Use Explore agent to find search/data/case candidates, existing infra, and delegation decisions |
| Confirm what to add | Confirming the AI summary plan | Present manifest and confirm which APIs and targets to integrate |
| Set up data access for AI | Setting up Web API access and permissions | Invoke /create-webroles if needed, then /integrate-webapi in AI-only read mode (or skip for search-only) |
| Add AI summary code | Adding AI summary code to your pages | Sequential ai-webapi-integration calls: first target creates shared service + CSRF helper, remaining targets extend it |
| Register AI prompts | Registering AI prompt settings | Invoke ai-webapi-settings-architect to create Summarization/* settings |
| Verify everything | Verifying file inventory, headers, and the build | Confirm service file, wrappers, UI wiring, header contract, run project build |
| Review and deploy | Reviewing summary and deploying | Record skill usage, present summary, offer /deploy-site, give post-deploy guidance |

Mark each task `in_progress` when starting and `completed` when done via `TaskUpdate`.

---

**Begin with Phase 1: Verify Site Exists**
